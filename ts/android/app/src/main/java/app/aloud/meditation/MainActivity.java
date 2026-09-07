package app.aloud.meditation;

import android.content.Context;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final String TAG = "AloudAudio";
    private AudioManager.OnModeChangedListener modeListener;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // The WebView's WebRTC capture (hosted STT / VAD with echo cancellation)
        // puts Android in communication mode for the life of the process, and
        // the facilitator then plays on the CALL stream (measured 2026-09-07:
        // every TTS track is STREAM_VOICE_CALL / USAGE_VOICE_COMMUNICATION).
        // This pin cannot override an active communication mode - the rocker
        // still moves the call stream - but it is what the keys do outside one.
        setVolumeControlStream(AudioManager.STREAM_MUSIC);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
            modeListener = mode -> {
                if (mode == AudioManager.MODE_IN_COMMUNICATION) ensureSpeakerRoute("mode change");
            };
            am.addOnModeChangedListener(getMainExecutor(), modeListener);
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        ensureSpeakerRoute("resume");
    }

    @Override
    public void onDestroy() {
        if (modeListener != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            ((AudioManager) getSystemService(Context.AUDIO_SERVICE)).removeOnModeChangedListener(modeListener);
        }
        super.onDestroy();
    }

    /**
     * In communication mode Android routes playback to the EARPIECE unless
     * someone asks for the speaker. The WebView asks once, when it turns the
     * mode on; the audio service drops that request while the app is in the
     * background ("removeInactiveRouteClient"), and on resume the WebView gets
     * the mode back without re-asking. Every reply after a lock/unlock then
     * played out of the earpiece: quiet at the same slider, a clipped onset,
     * and the echo canceller's reference no longer matching the room
     * (meditation-pal-wxj5). Re-ask for the speaker ourselves, but only when
     * the fallback is what we have - a headset or Bluetooth route is the
     * user's choice and stays.
     */
    private void ensureSpeakerRoute(String why) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return;
        AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        if (am.getMode() != AudioManager.MODE_IN_COMMUNICATION) return;
        AudioDeviceInfo current = am.getCommunicationDevice();
        if (current != null && current.getType() != AudioDeviceInfo.TYPE_BUILTIN_EARPIECE) {
            Log.d(TAG, "route on " + why + ": device type " + current.getType() + " - leaving it");
            return;
        }
        for (AudioDeviceInfo dev : am.getAvailableCommunicationDevices()) {
            if (dev.getType() == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) {
                boolean ok = am.setCommunicationDevice(dev);
                Log.d(TAG, "route on " + why + ": earpiece -> speaker " + (ok ? "ok" : "REFUSED"));
                return;
            }
        }
        Log.d(TAG, "route on " + why + ": no speaker device available");
    }
}
