/**
 * Runs inside the app (injected by capture-ui.mjs) to film it one frame at a
 * time. Two jobs:
 *
 *  - Hold the page's clock. Everything that moves in the UI is a CSS animation,
 *    a transition or a Web Animation, so each frame pauses whatever is running
 *    and sets it to that frame's time. The capture is then exact at any speed.
 *  - Put the script's words on the real session screen. A sit needs a mic, a
 *    model and a person, so the turns are written into the transcript with the
 *    app's own markup and classes, in step with the soundtrack. The screen
 *    around them (orb, nav, clock, controls) is the live view.
 */
window.__film = (() => {
    const seen = new WeakMap();
    let firstFrame = true;

    function stepAnimations(t) {
        for (const anim of document.getAnimations()) {
            let s = seen.get(anim);
            if (!s) {
                // One already running when filming starts keeps its place;
                // one that starts mid-shot starts from its beginning.
                s = { t0: t, base: firstFrame ? Number(anim.currentTime ?? 0) : 0 };
                seen.set(anim, s);
                try {
                    anim.pause();
                } catch {
                    continue;
                }
            }
            const target = s.base + (t - s.t0) * 1000;
            const end = anim.effect?.getComputedTiming().endTime;
            try {
                if (Number.isFinite(end) && target >= end) anim.finish();
                else anim.currentTime = target;
            } catch {
                /* a cancelled animation: nothing to hold */
            }
        }
        firstFrame = false;
    }

    /** Anything the mic-less, model-less session put up over the view. */
    function clearNoise() {
        for (const el of document.querySelectorAll(
            '.error-toast, .voice-modal-overlay, .app-dialog-overlay, .modal-overlay, .tour-overlay, #dev-sim-banner, #stt-trouble'
        )) {
            if (el.id === 'stt-trouble') el.classList.add('hidden');
            else el.remove();
        }
    }

    const $ = (sel) => document.querySelector(sel);
    const clockText = (sec) => {
        const s = Math.max(0, Math.floor(sec));
        return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };
    /** A reply as the app shows it: each TTS chunk appears as its audio starts. */
    const spoken = (line, t) => {
        const said = line.chunks.filter((c) => t >= c.t).map((c) => c.text);
        return said.length ? said.join(' ') : null;
    };
    /** Speech as the recognizer shows it: word by word, a beat behind the voice. */
    const heard = (line, t, lag = 0.18) => {
        const said = line.words.filter((w) => t >= w.t + lag).map((w) => w.w);
        return said.length ? said.join(' ') : null;
    };

    /**
     * Keep the transcript at exactly `bubbles`: [{ role, text, partial, sender }]
     * with a null text meaning "not said yet". Bubbles are made once with the
     * app's markup, so each plays its real entrance when it first appears.
     */
    function transcript(conversation, made, bubbles) {
        const typing = conversation.querySelector('#typing-indicator');
        bubbles.forEach((b, i) => {
            let el = made[i];
            if (b.text === null) {
                el?.remove();
                made[i] = null;
                return;
            }
            if (!el) {
                el = document.createElement('div');
                if (b.sender) {
                    const sender = document.createElement('div');
                    sender.className = 'message-sender';
                    sender.textContent = b.sender;
                    el.appendChild(sender);
                }
                const content = document.createElement('div');
                content.className = 'message-content';
                el.appendChild(content);
                made[i] = el;
                const before = made.slice(i + 1).find(Boolean) ?? typing;
                conversation.insertBefore(el, before && before.parentNode === conversation ? before : null);
            }
            const cls = `message ${b.role}${b.partial ? ' partial' : ''}`;
            if (el.className !== cls) el.className = cls;
            const content = el.querySelector('.message-content');
            if (content.textContent !== b.text) content.textContent = b.text;
        });
        conversation.scrollTop = conversation.scrollHeight;
    }

    /** Shared session-screen state: status line, typing dots, clock, voice label. */
    function sessionChrome({ status, typing, clock, voice }) {
        const statusEl = $('#voice-status');
        if (statusEl && statusEl.textContent !== status) statusEl.textContent = status;
        const dots = $('#typing-indicator');
        if (dots) dots.classList.toggle('visible', Boolean(typing));
        const timer = $('#timer');
        if (timer) {
            if (timer.textContent !== clock) timer.textContent = clock;
            timer.classList.remove('hidden', 'session-clock-reveal', 'session-timer-final');
        }
        const voiceBtn = $('#voice-picker-btn');
        if (voiceBtn && voice && voiceBtn.textContent !== voice) voiceBtn.textContent = voice;
    }

    /**
     * Take the parts of the session screen the shot writes to out of the
     * session's hands, by swapping each for a copy of itself. The session keeps
     * writing to the originals (its clock ticks, its opener arrives, its
     * recognizer reports), which are no longer on screen, so nothing it does
     * can land between a frame being set and being photographed.
     */
    function takeOver() {
        for (const sel of ['#conversation', '#voice-status', '#timer', '#voice-picker-btn']) {
            const el = $(sel);
            if (el) el.replaceWith(el.cloneNode(true));
        }
    }

    /** Drop whatever the session itself wrote into the transcript on mount. */
    function emptyTranscript() {
        const conversation = $('#conversation');
        for (const child of [...conversation.children]) {
            if (child.id !== 'typing-indicator') child.remove();
        }
        document.getElementById('facilitator-status-hint')?.remove();
        return conversation;
    }

    const VOICE = 'Harper · 140 wpm';

    const shots = {
        /** Beat 2: the opener, his reply, the question back. */
        hook(tl, shot) {
            const { f0, e1, f1 } = tl.lines;
            const conversation = emptyTranscript();
            const made = [];
            const thinkingFrom = e1 ? e1.voiceEnd + 0.45 : Infinity;
            return (t) => {
                transcript(conversation, made, [
                    ...(f0 ? [{ role: 'facilitator', text: spoken(f0, t) }] : []),
                    ...(e1 ? [{ role: 'user', text: heard(e1, t), partial: t < e1.voiceEnd + 0.3 }] : []),
                    ...(f1 ? [{ role: 'facilitator', text: spoken(f1, t) }] : []),
                ]);
                const speaking = [f0, f1].some((l) => l && t >= l.chunks[0].t && t < l.voiceEnd + 0.2);
                const waiting = (f0 && t < f0.chunks[0].t) || (f1 && t >= thinkingFrom && t < f1.chunks[0].t);
                sessionChrome({
                    status: speaking ? 'Speaking…' : waiting ? 'Thinking…' : 'Listening…',
                    typing: waiting,
                    clock: clockText(t - shot.from + 1),
                    voice: VOICE,
                });
            };
        },

        /** Beat 4: the felt sense opener, on the felt sense screen. */
        felt(tl, shot) {
            const { f3 } = tl.lines;
            const conversation = emptyTranscript();
            const made = [];
            return (t) => {
                transcript(conversation, made, [{ role: 'facilitator', text: spoken(f3, t) }]);
                const waiting = t < f3.chunks[0].t;
                sessionChrome({
                    status: waiting ? 'Thinking…' : t < f3.voiceEnd + 0.2 ? 'Speaking…' : 'Listening…',
                    typing: waiting,
                    clock: clockText(t - shot.from + 1),
                    voice: VOICE,
                });
            };
        },

        /** Beat 5: one note, then the bowl takes its turn. The circle's own
         *  spoken introduction stays as the session wrote it. */
        noting(tl, shot) {
            const { n1 } = tl.lines;
            const conversation = $('#conversation');
            const made = [];
            const strike = tl.marks.notingBowl;
            return (t) => {
                transcript(conversation, made, [
                    { role: 'user', sender: 'You', text: heard(n1, t, 0.1) },
                    { role: 'facilitator', sender: 'Bowl', text: t >= strike ? '〈Bowl〉' : null },
                ]);
                sessionChrome({
                    status:
                        t < n1.voiceEnd + 0.15
                            ? 'Your turn. Say something you notice now, 1-2 words.'
                            : t < strike + 1
                              ? 'Bowl is noting…'
                              : 'Your turn. Say something you notice now, 1-2 words.',
                    typing: false,
                    clock: clockText(t - shot.from + 41),
                });
            };
        },

        /** Beat 6, the end of it: mid-sit, a timer asked for aloud. The clock
         *  counts the sit until the request lands, then counts down from it. */
        timer(tl, shot) {
            const { f0, e1, f1, v1 } = tl.lines;
            const conversation = emptyTranscript();
            const made = [];
            const lands = tl.marks.timerLands;
            const minutes = 10;
            return (t) => {
                transcript(conversation, made, [
                    ...(f0 ? [{ role: 'facilitator', text: f0.text }] : []),
                    ...(e1 ? [{ role: 'user', text: e1.text }] : []),
                    ...(f1 ? [{ role: 'facilitator', text: f1.text }] : []),
                    { role: 'user', text: heard(v1, t), partial: t < v1.voiceEnd + 0.2 },
                ]);
                sessionChrome({
                    status: t < v1.voiceEnd + 0.2 ? 'Listening…' : 'Thinking…',
                    typing: t >= v1.voiceEnd + 0.2,
                    clock: t < lands ? clockText(t - shot.from + 252) : clockText(minutes * 60 - (t - lands)),
                    voice: VOICE,
                });
            };
        },

        /** Beat 6: the setup controls, worked by real clicks on the real form. */
        setup(tl, shot) {
            const pending = shot.actions.map((a) => ({ ...a }));
            return (t) => {
                for (const action of pending) {
                    if (action.done || t < action.t) continue;
                    action.done = true;
                    const el = $(action.selector);
                    if (!el) throw new Error(`no ${action.selector} to work`);
                    if (action.value !== undefined) {
                        el.value = String(action.value);
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                    } else {
                        el.click();
                    }
                }
            };
        },
    };

    let stage = () => {};
    return {
        init(shot, timeline) {
            clearNoise();
            if (shot.stage !== 'setup') takeOver();
            stage = shots[shot.stage](timeline, shot);
        },
        /** Set the screen for time `t` and let it play: used once before
         *  filming, so what the opening frame holds has finished arriving. */
        settle(t) {
            clearNoise();
            stage(t);
        },
        /** Set the screen for time `t` and hold every animation there. */
        frame(t) {
            clearNoise();
            stage(t);
            stepAnimations(t);
        },
    };
})();
