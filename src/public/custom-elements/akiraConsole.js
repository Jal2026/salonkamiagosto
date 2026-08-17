/* ═══════════════════════════════════════════════════════════════════════════
 * KAMISUITE — AKIRA Console (Wix Custom Element)
 * Archivo:  akiraConsole.js
 * Ubicación en Wix: public/custom-elements/
 * Tag name: akira-console
 * VERSION:  0.6.4 (Diagnóstico micrófono Desktop)
 * FECHA:    28 Abril 2026
 *
 * CHANGELOG
 *   v0.6.4 - DIAG: 4 console.log en _startStandardSession (onstart,
 *            onaudiostart, onresult, onend) para depurar micro en
 *            equipos Desktop donde no se recoge audio.
 *   v0.6.3 - FIX: errores de acción/consulta se muestran como mensaje
 *            normal de AKIRA (no en rojo) y se hablan por voz.
 *            Solo errores de sistema sin texto muestran burbuja roja.
 *            _handleResponse reescrito para priorizar respuesta hablada.
 *   v0.6.2 - Revert mic auto-start de v0.6.1.
 *   v0.6.1 - (parcialmente revertida) Mic auto-start + TTS rate 1.25.
 *   v0.6.0 - iOS TTS: _ensureTTSUnlocked invocable + logs diagnóstico.
 *   v0.5.7 - Android: no interim, buffer separado, nueva SR.
 *   v0.5.3 - Confirm por voz + mic reactiva.
 *   v0.5.2 - Desktop: preparing/listening states.
 *   v0.5.0 - Fase 5: paridad con producción.
 * ═══════════════════════════════════════════════════════════════════════════
 */

(function () {
  'use strict';

  if (customElements.get('akira-console')) {
    console.log('[AKIRA Console v0.6.4] Ya registrado, omitiendo.');
    return;
  }

  const VERSION = '0.6.4';
  const TAG = `[AKIRA Console v${VERSION}]`;
  const MAX_HISTORY = 10;
  const SILENCE_MS = 1800;
  const SAFETY_MS = 15000;

  const IS_ANDROID = /android/i.test(navigator.userAgent);
  const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
              || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  const TTS_RATE = IS_IOS ? 1.1 : 1.25;

  const VOICE_CONFIRM_WORDS = ['si', 'confirma', 'confirmar', 'confirmo', 'adelante', 'dale', 'ok', 'okay', 'vale', 'correcto', 'claro', 'venga'];
  const VOICE_CANCEL_WORDS = ['no', 'cancela', 'cancelar', 'dejalo', 'para'];

  function stripAccents(s) {
    return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  }

  const PRONUNCIACION = {
    'KAMISUITE':'Kamisuit','kamisuite':'kamisuit','Kamisuite':'Kamisuit',
    'AKIRA':'Akira','Kerastase':'Kerastás','KERASTASE':'Kerastás','Kérastase':'Kerastás',
    'Redken':'Rédken','REDKEN':'Rédken','Olaplex':'Olaplex','OLAPLEX':'Olaplex',
    'Nanoplastia':'Nanoplástia','All Soft':'Ol Soft','Anti-Frizz':'Anti fris',
    'Bain':'Ben','Botox':'Bótox','Bizum':'Bísum',
    'check-in':'chekin','Check-in':'Chekin','checkout':'chekaut',
    'staff':'estaf','Staff':'Estaf','STAFF':'Estaf'
  };

  function pronunciar(text) {
    let result = text;
    for (const word in PRONUNCIACION) {
      const regex = new RegExp('\\b' + word.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&') + '\\b', 'g');
      result = result.replace(regex, PRONUNCIACION[word]);
    }
    return result;
  }

  function separarTelefonos(text) {
    let result = text.replace(/\d{7,}/g, (m) => m.split('').join(' '));
    result = result.replace(/\b(\d{2,4})([\s\-]\d{2,4}){2,}\b/g, (m) => {
      const digits = m.replace(/[\s\-]/g, '');
      if (digits.length >= 7) return digits.split('').join(' ');
      return m;
    });
    return result;
  }

  class AkiraConsole extends HTMLElement {

    static get observedAttributes() { return ['response']; }

    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this._chatHistory = [];
      this._isThinking = false;
      this._pendingMessageId = null;
      this._msgCounter = 0;
      this._voiceEnabled = true;
      this._selectedVoice = null;
      this._allSpanishVoices = [];
      this._speakQueue = [];
      this._isSpeaking = false;
      this._welcomeSpoken = false;
      this._SR = null;
      this._recognition = null;
      this._isListening = false;
      this._continuousMode = false;
      this._silenceTimer = null;
      this._safetyTimer = null;
      this._lastFinalTranscript = '';
      this._pendingConfirmButtons = null;
      this._micStoppingForSend = false;
      this._androidFinalBuffer = '';
      this._currentUtterance = null;
      this._ttsWarmedUp = false;
      this._ttsUnlocked = !IS_IOS;
      this._onTTSUnlocked = null;
    }

    connectedCallback() {
      this._render();
      this._initVisualState();
      this._bindEvents();
      this._setupVoices();
      this._setupMic();
      console.log(`${TAG} Montado. Platform: ${IS_ANDROID ? 'Android' : IS_IOS ? 'iOS' : 'Desktop'} ttsRate=${TTS_RATE}`);
    }

    attributeChangedCallback(name, oldValue, newValue) {
      if (name !== 'response' || !newValue || oldValue === newValue) return;
      let payload;
      try { payload = JSON.parse(newValue); } catch (e) { return; }
      this._handleResponse(payload);
    }

    // ═════════════════════════════════════════════════════════════════════
    // v0.6.3: HANDLE RESPONSE — errores como mensajes normales hablados
    // ═════════════════════════════════════════════════════════════════════
    _handleResponse(payload) {
      this._hideTyping();
      this._setThinking(false);
      if (payload.messageId && this._pendingMessageId && payload.messageId !== this._pendingMessageId) return;

      // Confirmación de acción → burbuja con botones
      if (payload.action === 'confirm' && payload.message) {
        this._appendActionConfirm(payload.message, payload.messageId);
        if (this._voiceEnabled) { this._speakResponse(payload.message); }
        else { this._tryReactivateMic(); }
        return;
      }

      // v0.6.3: Cualquier texto (respuesta o error) se muestra como mensaje
      // normal de AKIRA y se habla. Solo si no hay ningún texto → burbuja roja.
      const text = payload.respuesta || (typeof payload.error === 'string' ? payload.error : null)
                || (payload.error?.message) || null;

      if (text) {
        this._appendAiMessage(text);
        if (this._voiceEnabled) { this._speakResponse(text); }
        else { this._tryReactivateMic(); }
      } else {
        // Error de sistema sin texto legible
        this._appendErrorMessage('Error de conexión. Inténtalo de nuevo.');
        if (this._voiceEnabled) { this._speakResponse('Ha ocurrido un error de conexión. Inténtalo de nuevo.'); }
        else { this._tryReactivateMic(); }
      }
      this._pendingMessageId = null;
    }

    _sendQuery(query) {
      this._msgCounter++;
      const messageId = `msg_${this._msgCounter}_${Date.now()}`;
      this._pendingMessageId = messageId;
      this.dispatchEvent(new CustomEvent('akira-query', {
        detail: { query, messageId, history: this._chatHistory.slice(-MAX_HISTORY) },
        bubbles: true, composed: true
      }));
    }

    _bindEvents() {
      const input = this.shadowRoot.getElementById('chatInput');
      const btn = this.shadowRoot.getElementById('sendBtn');
      const voiceToggle = this.shadowRoot.getElementById('voiceToggle');
      const voiceSelect = this.shadowRoot.getElementById('voiceSelect');
      const micBtn = this.shadowRoot.getElementById('micBtn');
      const stopBtn = this.shadowRoot.getElementById('stopBtn');

      btn.addEventListener('click', () => this._handleSend());
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this._handleSend(); } });
      voiceToggle.addEventListener('click', () => this._toggleVoice());
      voiceSelect.addEventListener('change', (e) => this._onVoiceSelected(e));
      if (micBtn) micBtn.addEventListener('click', () => this._toggleMic());
      if (stopBtn) stopBtn.addEventListener('click', () => this._handleStop());

      input.addEventListener('focus', () => {
        if (this._voiceEnabled && !this._welcomeSpoken) {
          this._welcomeSpoken = true;
          this._speakResponse('Hola, soy AKIRA. ¿En qué te ayudo?');
        }
      }, { once: true });

      if (IS_IOS) {
        const warmupHandler = () => {
          if (!this._ttsWarmedUp) { this._ensureTTSUnlocked(() => {}); }
        };
        this.shadowRoot.addEventListener('pointerdown', warmupHandler, { once: true, capture: true });
      }
    }

    _ensureTTSUnlocked(callback) {
      if (this._ttsUnlocked) { if (callback) callback(); return; }
      if (!window.speechSynthesis) { this._ttsUnlocked = true; this._ttsWarmedUp = true; if (callback) callback(); return; }
      if (callback) this._onTTSUnlocked = callback;
      if (this._ttsWarmedUp) {
        setTimeout(() => { if (!this._ttsUnlocked) { this._ttsUnlocked = true; this._fireTTSUnlockedCallback(); } }, 2000);
        return;
      }
      this._ttsWarmedUp = true;
      if (IS_IOS) {
        const voices = window.speechSynthesis.getVoices();
        console.log(`${TAG} iOS DIAG warm-up: speaking=${window.speechSynthesis.speaking} pending=${window.speechSynthesis.pending} voices=${voices.length} voice=${this._selectedVoice?.name || 'none'}`);
      }
      this._currentUtterance = new SpeechSynthesisUtterance('Listo');
      this._currentUtterance.lang = 'es-ES';
      this._currentUtterance.volume = 0.15;
      this._currentUtterance.rate = 1.5;
      if (this._selectedVoice) this._currentUtterance.voice = this._selectedVoice;
      this._currentUtterance.onend = () => { this._ttsUnlocked = true; console.log(`${TAG} TTS desbloqueado.`); this._fireTTSUnlockedCallback(); };
      this._currentUtterance.onerror = (e) => { this._ttsUnlocked = true; console.warn(`${TAG} TTS warm-up onerror:`, e?.error); this._fireTTSUnlockedCallback(); };
      try { window.speechSynthesis.speak(this._currentUtterance); } catch (err) { this._ttsUnlocked = true; this._fireTTSUnlockedCallback(); }
      setTimeout(() => { if (!this._ttsUnlocked) { this._ttsUnlocked = true; this._fireTTSUnlockedCallback(); } }, 2000);
    }

    _fireTTSUnlockedCallback() {
      if (this._onTTSUnlocked) { const cb = this._onTTSUnlocked; this._onTTSUnlocked = null; cb(); }
    }

    _handleSend(fromMic = false) {
      if (this._isThinking) return;
      const input = this.shadowRoot.getElementById('chatInput');
      const text = (input.value || '').trim();
      if (!text) return;
      if (this._isListening) { this._continuousMode = false; this._stopMic(); }
      else if (!fromMic) { this._continuousMode = false; }
      this._cancelTTSIfSafe();
      this._speakQueue = []; this._isSpeaking = false; this._hideStopBtn();
      this._appendUserMessage(text);
      input.value = '';
      this._setThinking(true);
      this._showTyping();
      this._sendQuery(text);
    }

    _cancelTTSIfSafe() {
      if (!window.speechSynthesis) return;
      if (IS_IOS && !this._ttsUnlocked) return;
      if (window.speechSynthesis.speaking || window.speechSynthesis.pending) { window.speechSynthesis.cancel(); }
    }

    // ═════════════════════════════════════════════════════════════════════
    // VOZ — TTS
    // ═════════════════════════════════════════════════════════════════════
    _setupVoices() {
      if (!window.speechSynthesis) return;
      window.speechSynthesis.onvoiceschanged = () => this._loadVoices();
      this._loadVoices();
    }

    _loadVoices() {
      if (!window.speechSynthesis) return;
      const voices = window.speechSynthesis.getVoices();
      if (!voices || voices.length === 0) return;
      this._allSpanishVoices = voices.filter(v => v.lang && v.lang.startsWith('es'));
      if (this._allSpanishVoices.length === 0) return;
      const select = this.shadowRoot.getElementById('voiceSelect');
      if (!select) return;
      select.innerHTML = '';
      this._allSpanishVoices.forEach((v, i) => {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = v.name.replace('Microsoft ', '').replace('Google ', 'G:').replace(' Online (Natural)', '');
        select.appendChild(opt);
      });
      const bestIndex = this._findBestVoice();
      select.value = String(bestIndex);
      this._selectedVoice = this._allSpanishVoices[bestIndex];
      console.log(`${TAG} Voz elegida: ${this._selectedVoice.name}`);
    }

    _findBestVoice() {
      const MALE = /jorge|andr[eé]s|diego|pablo|enrique|juan|male|masculin|hombre/i;
      const voices = this._allSpanishVoices;
      const iosPrios = [
        v => /paulina/i.test(v.name) && v.lang.startsWith('es'),
        v => /m[oó]nica/i.test(v.name) && v.lang.startsWith('es'),
        v => v.lang.startsWith('es') && !/google/i.test(v.name) && !MALE.test(v.name),
        v => v.lang.startsWith('es') && !MALE.test(v.name)
      ];
      const defaultPrios = [
        v => /google/i.test(v.name) && /estados unidos|united states/i.test(v.name) && !MALE.test(v.name),
        v => /google/i.test(v.name) && /es[-_]us/i.test(v.lang) && !MALE.test(v.name),
        v => /natural/i.test(v.name) && v.lang.startsWith('es') && !MALE.test(v.name),
        v => v.lang.startsWith('es') && /m[oó]nica|conchita|elena|luc[ií]a|paulina|elvira/i.test(v.name),
        v => v.lang.startsWith('es') && /google/i.test(v.name) && !MALE.test(v.name),
        v => v.lang === 'es-ES' && !MALE.test(v.name),
        v => v.lang.startsWith('es') && !MALE.test(v.name)
      ];
      const prios = IS_IOS ? iosPrios : defaultPrios;
      for (const fn of prios) { for (let i = 0; i < voices.length; i++) { if (fn(voices[i])) return i; } }
      return 0;
    }

    _onVoiceSelected(event) {
      const idx = parseInt(event.target.value, 10);
      if (this._allSpanishVoices[idx]) {
        this._selectedVoice = this._allSpanishVoices[idx];
        if (this._voiceEnabled) this._speakResponse('Voz actualizada');
      }
    }

    _toggleVoice() {
      this._voiceEnabled = !this._voiceEnabled;
      const toggle = this.shadowRoot.getElementById('voiceToggle');
      const label = this.shadowRoot.getElementById('voiceToggleLabel');
      const select = this.shadowRoot.getElementById('voiceSelect');
      if (this._voiceEnabled) {
        toggle.classList.add('active'); label.textContent = 'ON'; select.classList.remove('hidden');
      } else {
        toggle.classList.remove('active'); label.textContent = 'Voz'; select.classList.add('hidden');
        this._cancelTTSIfSafe();
        this._speakQueue = []; this._isSpeaking = false;
      }
    }

    _speakResponse(text) {
      if (!this._voiceEnabled || !window.speechSynthesis) { this._tryReactivateMic(); return; }
      if (IS_IOS) {
        console.log(`${TAG} iOS DIAG _speakResponse: unlocked=${this._ttsUnlocked} speaking=${window.speechSynthesis.speaking} voice=${this._selectedVoice?.name || 'none'}`);
      }
      this._cancelTTSIfSafe();
      this._speakQueue = []; this._isSpeaking = false;
      let cleanText = text
        .replace(/€/g, ' euros').replace(/\n- /g, '. ').replace(/\n· /g, '. ')
        .replace(/\n/g, '. ').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
      cleanText = cleanText.replace(/(\.\s+){2,}/g, '. ').replace(/\.{2,}/g, '.');
      cleanText = separarTelefonos(cleanText);
      cleanText = pronunciar(cleanText);
      if (cleanText.length > 800) {
        cleanText = cleanText.substring(0, 800);
        const lastDot = cleanText.lastIndexOf('.');
        if (lastDot > 400) cleanText = cleanText.substring(0, lastDot + 1);
      }
      const sentences = cleanText.split(/(?<=[.;:])\s+/).filter(s => s.trim().length > 0);
      const chunks = [];
      sentences.forEach(s => {
        if (s.length > 150) {
          const parts = s.split(/,\s+/); let current = '';
          parts.forEach(p => {
            if ((current + ', ' + p).length > 150 && current) { chunks.push(current); current = p; }
            else { current = current ? current + ', ' + p : p; }
          });
          if (current) chunks.push(current);
        } else { chunks.push(s); }
      });
      this._speakQueue = chunks; this._showStopBtn(); this._speakNext();
    }

    _speakNext() {
      if (this._speakQueue.length === 0 || !this._voiceEnabled) {
        this._isSpeaking = false; this._hideStopBtn(); this._tryReactivateMic(); return;
      }
      this._isSpeaking = true;
      const chunk = this._speakQueue.shift();
      const chunkToSpeak = chunk.replace(/[.;:]+\s*$/, '').trim();
      if (!chunkToSpeak) { this._speakNext(); return; }
      this._currentUtterance = new SpeechSynthesisUtterance(chunkToSpeak);
      this._currentUtterance.lang = 'es-ES';
      this._currentUtterance.rate = TTS_RATE;
      this._currentUtterance.pitch = 1.1;
      if (this._selectedVoice) this._currentUtterance.voice = this._selectedVoice;
      this._currentUtterance.onend = () => {
        if (IS_IOS) console.log(`${TAG} iOS DIAG utterance onend`);
        this._speakNext();
      };
      this._currentUtterance.onerror = (e) => {
        if (IS_IOS) console.warn(`${TAG} iOS DIAG utterance onerror: ${e?.error}`);
        this._speakNext();
      };
      window.speechSynthesis.speak(this._currentUtterance);
    }

    // ═════════════════════════════════════════════════════════════════════
    // MICRÓFONO
    // ═════════════════════════════════════════════════════════════════════
    _setupMic() {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) { const b = this.shadowRoot.getElementById('micBtn'); if (b) b.style.display = 'none'; return; }
      this._SR = SR;
    }

    _clearSilenceTimer() { if (this._silenceTimer) { clearTimeout(this._silenceTimer); this._silenceTimer = null; } }
    _clearSafetyTimer() { if (this._safetyTimer) { clearTimeout(this._safetyTimer); this._safetyTimer = null; } }
    _armSilenceTimer() {
      this._clearSilenceTimer();
      this._silenceTimer = setTimeout(() => { this._micStoppingForSend = true; this._stopMic(); }, SILENCE_MS);
    }
    _armSafetyTimer() {
      this._clearSafetyTimer();
      this._safetyTimer = setTimeout(() => { this._micStoppingForSend = true; this._stopMic(); }, SAFETY_MS);
    }

    _toggleMic() {
      if (this._isListening) { this._continuousMode = false; this._stopMic(); }
      else { this._continuousMode = true; this._startMic(); }
    }

    _tryReactivateMic() {
      if (!this._continuousMode || !this._SR) return;
      if (this._isListening || this._isThinking || this._isSpeaking) return;
      setTimeout(() => {
        if (this._continuousMode && !this._isListening && !this._isThinking && !this._isSpeaking) {
          this._startMic();
        }
      }, 350);
    }

    _stopMic() {
      this._clearSilenceTimer();
      this._clearSafetyTimer();
      if (this._recognition) { try { this._recognition.stop(); } catch (_) {} }
    }

    _setMicState(state) {
      const btn = this.shadowRoot.getElementById('micBtn');
      if (!btn) return;
      btn.classList.remove('listening', 'idle', 'preparing');
      btn.classList.add(state);
    }

    _startMic() {
      if (!this._SR || this._isThinking) return;
      if (IS_IOS && !this._ttsUnlocked) {
        const input = this.shadowRoot.getElementById('chatInput');
        this._setMicState('preparing');
        input.placeholder = 'Activando voz...';
        this._ensureTTSUnlocked(() => { this._doStartMic(); });
        return;
      }
      this._doStartMic();
    }

    _doStartMic() {
      this._cancelTTSIfSafe();
      this._speakQueue = []; this._isSpeaking = false; this._hideStopBtn();
      this._micStoppingForSend = false;
      const input = this.shadowRoot.getElementById('chatInput');
      input.value = '';
      if (IS_ANDROID) {
        this._androidFinalBuffer = '';
        this._startAndroidSession(input);
      } else {
        this._startStandardSession(input);
      }
    }

    // ═════════════════════════════════════════════════════════════════════
    // ANDROID
    // ═════════════════════════════════════════════════════════════════════
    _startAndroidSession(input) {
      try { this._recognition = new this._SR(); }
      catch (e) { this._appendAiMessage('No se pudo iniciar el reconocimiento de voz.'); this._continuousMode = false; return; }
      this._recognition.lang = 'es-ES';
      this._recognition.interimResults = false;
      this._recognition.continuous = false;
      this._recognition.maxAlternatives = 1;

      this._recognition.onstart = () => {
        this._isListening = true; this._setMicState('preparing');
        input.placeholder = 'Preparando micrófono...'; this._armSafetyTimer();
      };
      this._recognition.onaudiostart = () => {
        this._setMicState('listening');
        input.placeholder = this._androidFinalBuffer ? 'Sigue hablando...' : 'Te escucho — habla con normalidad';
        if (navigator.vibrate) { try { navigator.vibrate(50); } catch (_) {} }
      };
      this._recognition.onresult = (event) => {
        this._clearSafetyTimer();
        const result = event.results[0];
        if (result && result.isFinal) {
          const transcript = result[0].transcript.trim();
          if (transcript) {
            this._androidFinalBuffer += (this._androidFinalBuffer ? ' ' : '') + transcript;
            input.value = this._androidFinalBuffer;
            this._armSilenceTimer();
          }
        }
      };
      this._recognition.onerror = (event) => {
        this._clearSilenceTimer(); this._clearSafetyTimer();
        if (event.error === 'no-speech') {
          this._isListening = false; this._setMicState('idle');
          if (this._androidFinalBuffer.trim()) {
            const text = this._androidFinalBuffer.trim();
            input.value = text; this._androidFinalBuffer = '';
            this._processMicResult(input, text);
          } else { input.placeholder = 'Pregunta a AKIRA...'; this._continuousMode = false; }
          return;
        }
        this._isListening = false; this._setMicState('idle');
        input.placeholder = 'Pregunta a AKIRA...';
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
          this._appendAiMessage('Permiso de micrófono denegado. Actívalo en los ajustes del navegador.');
        } else if (event.error !== 'aborted') {
          console.warn(`${TAG} Mic error: ${event.error}`);
        }
        this._continuousMode = false;
      };
      this._recognition.onend = () => {
        this._clearSafetyTimer();
        this._isListening = false; this._setMicState('idle');
        if (!this._micStoppingForSend && this._continuousMode && !this._isThinking) {
          setTimeout(() => {
            if (this._continuousMode && !this._isThinking && !this._isSpeaking) { this._startAndroidSession(input); }
          }, 150);
          return;
        }
        this._micStoppingForSend = false;
        const text = this._androidFinalBuffer.trim();
        this._androidFinalBuffer = '';
        if (!text) { input.placeholder = 'Pregunta a AKIRA...'; this._continuousMode = false; return; }
        if (this._isThinking) return;
        input.value = text;
        this._processMicResult(input, text);
      };
      try { this._recognition.start(); } catch (e) {
        this._setMicState('idle'); input.placeholder = 'Pregunta a AKIRA...'; this._continuousMode = false;
      }
    }

    // ═════════════════════════════════════════════════════════════════════
    // DESKTOP / iOS
    // ═════════════════════════════════════════════════════════════════════
    _startStandardSession(input) {
      try { this._recognition = new this._SR(); }
      catch (e) { this._appendAiMessage('No se pudo iniciar el reconocimiento de voz.'); this._continuousMode = false; return; }
      this._recognition.lang = 'es-ES';
      this._recognition.interimResults = true;
      this._recognition.continuous = true;
      this._recognition.maxAlternatives = 1;
      this._lastFinalTranscript = '';

      this._recognition.onstart = () => {
        this._isListening = true; this._setMicState('preparing');
        input.placeholder = 'Preparando micrófono...'; this._armSafetyTimer();
        console.log(`${TAG} DIAG MIC onstart — sesión iniciada`);
      };
      this._recognition.onaudiostart = () => {
        this._setMicState('listening');
        input.placeholder = 'Te escucho — habla con normalidad';
        if (navigator.vibrate) { try { navigator.vibrate(50); } catch (_) {} }
        console.log(`${TAG} DIAG MIC onaudiostart — audio capturándose`);
      };
      this._recognition.onresult = (event) => {
        this._clearSafetyTimer();
        let finalText = '', interimText = '';
        for (let i = 0; i < event.results.length; i++) {
          const transcript = event.results[i][0].transcript;
          if (event.results[i].isFinal) { finalText += transcript; }
          else { interimText += transcript; }
        }
        input.value = (finalText + interimText).trim();
        console.log(`${TAG} DIAG MIC onresult — final="${finalText}" interim="${interimText}"`);
        const hadNewFinal = finalText !== this._lastFinalTranscript;
        if (hadNewFinal && finalText) { this._lastFinalTranscript = finalText; this._armSilenceTimer(); }
        else if (!hadNewFinal && interimText) { this._clearSilenceTimer(); }
      };
      this._recognition.onerror = (event) => {
        this._clearSilenceTimer(); this._clearSafetyTimer();
        this._isListening = false; this._setMicState('idle');
        input.placeholder = 'Pregunta a AKIRA...';
        console.warn(`${TAG} DIAG MIC onerror — error="${event.error}"`);
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
          this._appendAiMessage('Permiso de micrófono denegado. Actívalo en los ajustes del navegador.');
        } else if (event.error !== 'no-speech' && event.error !== 'aborted') {
          console.warn(`${TAG} Mic error: ${event.error}`);
        }
        this._continuousMode = false;
      };
      this._recognition.onend = () => {
        this._clearSafetyTimer();
        this._isListening = false; this._setMicState('idle');
        let text = (input.value || '').trim();
        text = collapseRepetitions(text);
        if (text !== (input.value || '').trim()) { input.value = text; }
        console.log(`${TAG} DIAG MIC onend — texto final="${text}"`);
        if (!text) { input.placeholder = 'Pregunta a AKIRA...'; this._continuousMode = false; return; }
        if (this._isThinking) return;
        this._processMicResult(input, text);
      };
      try { this._recognition.start(); } catch (e) {
        this._setMicState('idle'); input.placeholder = 'Pregunta a AKIRA...'; this._continuousMode = false;
      }
    }

    // ═════════════════════════════════════════════════════════════════════
    _processMicResult(input, text) {
      if (this._pendingConfirmButtons) {
        const intent = detectConfirmIntent(text);
        if (intent === 'confirm') { this._pendingConfirmButtons.btnConfirm.click(); input.value = ''; input.placeholder = 'Pregunta a AKIRA...'; return; }
        if (intent === 'cancel') { this._pendingConfirmButtons.btnCancel.click(); input.value = ''; input.placeholder = 'Pregunta a AKIRA...'; return; }
        this._pendingConfirmButtons.btnCancel.click();
      }
      this._handleSend(true);
    }

    _handleStop() {
      this._cancelTTSIfSafe();
      this._speakQueue = []; this._isSpeaking = false; this._hideStopBtn();
      this._tryReactivateMic();
    }
    _showStopBtn() { const b = this.shadowRoot.getElementById('stopBtn'); if (b) b.style.display = 'flex'; }
    _hideStopBtn() { const b = this.shadowRoot.getElementById('stopBtn'); if (b) b.style.display = 'none'; }

    // ─────────────────────────────────────────────────────────────────────
    // DOM HELPERS
    // ─────────────────────────────────────────────────────────────────────
    _appendUserMessage(text) {
      this._chatHistory.push({ role: 'user', text });
      const area = this.shadowRoot.getElementById('chatArea'); const typing = this.shadowRoot.getElementById('typingMsg');
      const div = document.createElement('div'); div.className = 'msg user';
      div.innerHTML = '<div class="avatar user-av">TÚ</div><div class="bubble-wrap"><div class="bubble">' + escHtml(text) + '</div><div class="bubble-time">' + ahoraStr() + '</div></div>';
      area.insertBefore(div, typing); this._scrollBottom();
    }
    _appendAiMessage(text) {
      this._chatHistory.push({ role: 'assistant', text });
      const area = this.shadowRoot.getElementById('chatArea'); const typing = this.shadowRoot.getElementById('typingMsg');
      const div = document.createElement('div'); div.className = 'msg ai';
      div.innerHTML = '<div class="avatar ai-av">AK</div><div class="bubble-wrap"><div class="bubble">' + escHtml(text) + '</div><div class="bubble-time">' + ahoraStr() + '</div></div>';
      area.insertBefore(div, typing); this._scrollBottom();
    }
    _appendErrorMessage(text) {
      const area = this.shadowRoot.getElementById('chatArea'); const typing = this.shadowRoot.getElementById('typingMsg');
      const div = document.createElement('div'); div.className = 'msg error';
      div.innerHTML = '<div class="avatar ai-av">AK</div><div class="bubble-wrap"><div class="bubble error-bubble">⚠ ' + escHtml(text) + '</div><div class="bubble-time">' + ahoraStr() + '</div></div>';
      area.insertBefore(div, typing); this._scrollBottom();
    }
    _appendActionConfirm(message, messageId) {
      const area = this.shadowRoot.getElementById('chatArea'); const typing = this.shadowRoot.getElementById('typingMsg');
      const div = document.createElement('div'); div.className = 'msg ai';
      div.innerHTML = '<div class="avatar ai-av">AK</div><div class="bubble-wrap"><div class="bubble action-bubble">' + escHtml(message) + '</div><div class="action-buttons"><button class="btn-action btn-confirm">✓ Confirmar</button><button class="btn-action btn-cancel">✗ Cancelar</button></div><div class="bubble-time">' + ahoraStr() + '</div></div>';
      area.insertBefore(div, typing); this._scrollBottom();
      this._chatHistory.push({ role: 'assistant', text: message });
      const btnConfirm = div.querySelector('.btn-confirm');
      const btnCancel = div.querySelector('.btn-cancel');
      this._pendingConfirmButtons = { btnConfirm, btnCancel };
      btnConfirm.addEventListener('click', () => {
        btnConfirm.disabled = true; btnConfirm.textContent = 'Ejecutando…'; btnCancel.disabled = true;
        this._pendingConfirmButtons = null; this._setThinking(true); this._showTyping();
        this._cancelTTSIfSafe(); this._speakQueue = []; this._isSpeaking = false; this._hideStopBtn();
        this.dispatchEvent(new CustomEvent('akira-action-execute', { detail: { messageId }, bubbles: true, composed: true }));
      });
      btnCancel.addEventListener('click', () => {
        btnConfirm.disabled = true; btnCancel.disabled = true; this._pendingConfirmButtons = null;
        this.dispatchEvent(new CustomEvent('akira-action-cancel', { detail: { messageId }, bubbles: true, composed: true }));
      });
    }

    _showTyping() { this.shadowRoot.getElementById('typingMsg').style.display = 'flex'; this._scrollBottom(); }
    _hideTyping() { this.shadowRoot.getElementById('typingMsg').style.display = 'none'; }
    _scrollBottom() { const a = this.shadowRoot.getElementById('chatArea'); setTimeout(() => { a.scrollTop = a.scrollHeight; }, 50); }

    _setThinking(thinking) {
      this._isThinking = thinking;
      const input = this.shadowRoot.getElementById('chatInput');
      const btn = this.shadowRoot.getElementById('sendBtn');
      const micBtn = this.shadowRoot.getElementById('micBtn');
      input.disabled = thinking; btn.disabled = thinking;
      if (micBtn) micBtn.disabled = thinking;
      input.placeholder = thinking ? 'AKIRA está procesando...' : 'Pregunta a AKIRA...';
    }

    _initVisualState() {
      const welcomeTime = this.shadowRoot.getElementById('welcomeTime');
      if (welcomeTime) welcomeTime.textContent = ahoraStr();
      if (this._voiceEnabled) {
        const toggle = this.shadowRoot.getElementById('voiceToggle');
        const label = this.shadowRoot.getElementById('voiceToggleLabel');
        const select = this.shadowRoot.getElementById('voiceSelect');
        if (toggle) toggle.classList.add('active');
        if (label) label.textContent = 'ON';
        if (select) select.classList.remove('hidden');
      }
    }

    _render() {
      this.shadowRoot.innerHTML = `
        <style>
          @import url('https://fonts.googleapis.com/css2?family=Bai+Jamjuree:wght@400;500;600&display=swap');
          :host { display:block; width:100%; height:100%; min-height:500px; font-family:'Bai Jamjuree',sans-serif; }
          * { box-sizing:border-box; margin:0; padding:0; font-family:'Bai Jamjuree',sans-serif; }
          .console-wrap { display:flex; flex-direction:column; width:100%; height:100%; min-height:500px; background:#fff; border:0.5px solid rgba(0,0,0,0.12); border-radius:12px; overflow:hidden; }
          .console-header { display:flex; align-items:center; gap:10px; padding:14px 18px; border-bottom:0.5px solid rgba(0,0,0,0.1); background:#f7f7f5; flex-shrink:0; }
          .console-icon { width:34px; height:34px; border-radius:8px; background:#243665; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
          .console-icon svg { width:18px; height:18px; }
          .console-name { font-size:15px; font-weight:600; color:#1a1a1a; }
          .console-sub { font-size:11px; color:#888; letter-spacing:0.04em; text-transform:uppercase; }
          .header-right { display:flex; align-items:center; gap:8px; margin-left:auto; }
          .status-dot { width:7px; height:7px; border-radius:50%; background:#243665; }
          .status-label { font-size:11px; color:#243665; }
          .voice-controls { display:flex; align-items:center; gap:4px; }
          .voice-toggle { display:flex; align-items:center; gap:4px; cursor:pointer; padding:3px 8px; border-radius:12px; border:0.5px solid rgba(0,0,0,0.15); background:#fff; transition:all 0.2s; font-size:11px; color:#888; user-select:none; }
          .voice-toggle.active { background:#e8edf7; border-color:#243665; color:#243665; }
          .voice-toggle svg { width:13px; height:13px; }
          .voice-select { font-size:11px; font-family:'Bai Jamjuree',sans-serif; padding:2px 4px; border:0.5px solid rgba(0,0,0,0.15); border-radius:8px; background:#fff; color:#666; max-width:120px; cursor:pointer; outline:none; }
          .voice-select.hidden { display:none; }
          .chat-area { flex:1; overflow-y:auto; padding:20px 18px; display:flex; flex-direction:column; gap:16px; scroll-behavior:smooth; }
          .msg { display:flex; gap:10px; max-width:90%; }
          .msg.user { align-self:flex-end; flex-direction:row-reverse; }
          .msg.ai { align-self:flex-start; }
          .msg.error { align-self:flex-start; }
          .avatar { width:28px; height:28px; border-radius:50%; flex-shrink:0; display:flex; align-items:center; justify-content:center; font-size:10px; font-weight:600; margin-top:2px; }
          .avatar.ai-av { background:#e8edf7; color:#243665; }
          .avatar.user-av { background:#dbeafe; color:#1e40af; }
          .bubble-wrap { display:flex; flex-direction:column; }
          .bubble { padding:10px 14px; font-size:13.5px; line-height:1.6; white-space:pre-wrap; word-break:break-word; }
          .msg.ai .bubble { background:#f7f7f5; border-radius:4px 14px 14px 14px; border:0.5px solid rgba(0,0,0,0.1); color:#1a1a1a; }
          .msg.user .bubble { background:#243665; color:#fff; border-radius:14px 4px 14px 14px; }
          .msg.error .bubble.error-bubble { background:#fef2f2; border:0.5px solid #fca5a5; color:#991b1b; border-radius:4px 14px 14px 14px; }
          .bubble.action-bubble { background:#eef2f9; border:1px solid #c5d0e6; color:#1a1a1a; border-radius:4px 14px 14px 14px; }
          .action-buttons { display:flex; gap:8px; margin-top:8px; }
          .btn-action { padding:7px 16px; border-radius:8px; border:none; font-family:'Bai Jamjuree',sans-serif; font-size:12px; font-weight:600; cursor:pointer; transition:all 0.15s; }
          .btn-action:disabled { opacity:0.4; cursor:not-allowed; }
          .btn-confirm { background:#243665; color:#fff; }
          .btn-confirm:hover:not(:disabled) { background:#1a2a50; }
          .btn-cancel { background:transparent; color:#666; border:1px solid rgba(0,0,0,0.2); }
          .btn-cancel:hover:not(:disabled) { border-color:#991b1b; color:#991b1b; }
          .bubble-time { font-size:10px; color:#aaa; margin-top:4px; padding:0 4px; }
          .msg.user .bubble-time { text-align:right; }
          .typing { display:flex; gap:4px; padding:8px 2px; align-items:center; }
          .dot { width:6px; height:6px; border-radius:50%; background:#8fa3cc; animation:blink 1.2s infinite; }
          .dot:nth-child(2) { animation-delay:0.2s; }
          .dot:nth-child(3) { animation-delay:0.4s; }
          @keyframes blink { 0%,80%,100%{opacity:0.3} 40%{opacity:1} }
          .input-row { display:flex; gap:8px; align-items:center; padding:12px 18px; border-top:0.5px solid rgba(0,0,0,0.1); flex-shrink:0; }
          .chat-input { flex:1; padding:9px 14px; border:0.5px solid rgba(0,0,0,0.2); border-radius:22px; font-size:13.5px; font-family:'Bai Jamjuree',sans-serif; background:#f7f7f5; color:#1a1a1a; outline:none; }
          .chat-input:focus { border-color:#243665; background:#fff; }
          .chat-input::placeholder { color:#aaa; }
          .chat-input:disabled { opacity:0.55; cursor:not-allowed; }
          .mic-btn { width:36px; height:36px; border-radius:50%; background:#f7f7f5; cursor:pointer; display:flex; align-items:center; justify-content:center; flex-shrink:0; transition:all 0.15s; border:0.5px solid rgba(0,0,0,0.2); }
          .mic-btn:hover:not(:disabled) { background:#e8edf7; border-color:#243665; }
          .mic-btn:disabled { opacity:0.4; cursor:not-allowed; }
          .mic-btn svg { width:16px; height:16px; color:#666; }
          .mic-btn.preparing { background:#e8edf7; border-color:#243665; animation:pulse-blue 1.2s infinite; }
          .mic-btn.preparing svg { color:#243665; }
          @keyframes pulse-blue { 0%{box-shadow:0 0 0 0 rgba(36,54,101,0.45)} 70%{box-shadow:0 0 0 8px rgba(36,54,101,0)} 100%{box-shadow:0 0 0 0 rgba(36,54,101,0)} }
          .mic-btn.listening { background:#fef2f2; border-color:#dc2626; animation:pulse-red 1.2s infinite; }
          .mic-btn.listening svg { color:#dc2626; }
          @keyframes pulse-red { 0%{box-shadow:0 0 0 0 rgba(220,38,38,0.55)} 70%{box-shadow:0 0 0 10px rgba(220,38,38,0)} 100%{box-shadow:0 0 0 0 rgba(220,38,38,0)} }
          .stop-btn { width:36px; height:36px; border-radius:50%; background:#dc2626; cursor:pointer; display:none; align-items:center; justify-content:center; flex-shrink:0; border:none; animation:pulse-red-soft 1.5s infinite; }
          .stop-btn:hover { background:#b91c1c; }
          .stop-btn svg { width:13px; height:13px; color:#fff; }
          @keyframes pulse-red-soft { 0%,100%{box-shadow:0 0 0 0 rgba(220,38,38,0.55)} 50%{box-shadow:0 0 0 7px rgba(220,38,38,0)} }
          .send-btn { width:36px; height:36px; border-radius:50%; border:none; background:#243665; cursor:pointer; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
          .send-btn:hover:not(:disabled) { background:#1a2a50; }
          .send-btn:disabled { opacity:0.4; cursor:not-allowed; }
          .send-btn svg { width:15px; height:15px; }
        </style>
        <div class="console-wrap">
          <div class="console-header">
            <div class="console-icon"><svg viewBox="0 0 24 24" fill="none"><path d="M12 2L13.5 7H19L14.5 10.5L16 15.5L12 12L8 15.5L9.5 10.5L5 7H10.5L12 2Z" fill="white" opacity="0.95"/></svg></div>
            <div><div class="console-name">AKIRA</div><div class="console-sub">KAMISUITE IA · Lab</div></div>
            <div class="header-right">
              <div class="voice-controls">
                <div class="voice-toggle" id="voiceToggle" title="Respuesta por voz"><svg viewBox="0 0 24 24" fill="none"><path d="M11 5L6 9H2v6h4l5 4V5z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><span id="voiceToggleLabel">Voz</span></div>
                <select class="voice-select hidden" id="voiceSelect" title="Seleccionar voz"></select>
              </div>
              <div class="status-dot"></div><div class="status-label">Activo</div>
            </div>
          </div>
          <div class="chat-area" id="chatArea">
            <div class="msg ai"><div class="avatar ai-av">AK</div><div class="bubble-wrap"><div class="bubble">Hola, soy AKIRA, la inteligencia de KAMISUITE. Puedo consultar agenda, clientes, facturación, disponibilidad, servicios, productos y promociones. ¿En qué te ayudo?</div><div class="bubble-time" id="welcomeTime"></div></div></div>
            <div class="msg ai" id="typingMsg" style="display:none"><div class="avatar ai-av">AK</div><div class="bubble-wrap"><div class="bubble"><div class="typing"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div></div></div></div>
          </div>
          <div class="input-row">
            <button class="mic-btn idle" id="micBtn" title="Hablar a AKIRA"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg></button>
            <button class="stop-btn" id="stopBtn" title="Detener voz"><svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg></button>
            <input class="chat-input" id="chatInput" type="text" placeholder="Pregunta a AKIRA..." autocomplete="off" />
            <button class="send-btn" id="sendBtn"><svg viewBox="0 0 24 24" fill="none"><path d="M22 2L11 13" stroke="white" stroke-width="2" stroke-linecap="round"/><path d="M22 2L15 22L11 13L2 9L22 2Z" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
          </div>
        </div>
      `;
    }
  }

  function ahoraStr() { return new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }); }
  function escHtml(text) { return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '<br>'); }
  function collapseRepetitions(text) {
    if (!text) return text;
    const words = text.split(/\s+/); if (words.length < 2) return text;
    const out = []; let prev = '';
    for (const w of words) { const key = stripAccents(w); if (key && key === prev) continue; out.push(w); prev = key; }
    let result = out.join(' ');
    for (let n = 5; n >= 2; n--) { result = result.replace(new RegExp(`(\\b(?:\\S+\\s+){${n-1}}\\S+\\b)(?:\\s+\\1)+`,'gi'), '$1'); }
    return result.trim();
  }
  function detectConfirmIntent(text) {
    const norm = stripAccents(text); const tokens = norm.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return 'other';
    if (tokens.length <= 4) {
      for (const w of tokens) { if (VOICE_CONFIRM_WORDS.includes(w)) return 'confirm'; }
      for (const w of tokens) { if (VOICE_CANCEL_WORDS.includes(w)) return 'cancel'; }
    }
    return 'other';
  }

  customElements.define('akira-console', AkiraConsole);
  console.log(`${TAG} Registrado. Platform: ${IS_ANDROID ? 'Android' : IS_IOS ? 'iOS' : 'Desktop'} ttsRate=${TTS_RATE}`);
})();