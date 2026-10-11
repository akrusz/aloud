package app.aloud.meditation;

import android.content.Context;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;

import androidx.activity.EdgeToEdge;

import com.getcapacitor.BridgeActivity;

import java.util.List;

public class MainActivity extends BridgeActivity {
    private static final String TAG = "AloudAudio";
    private AudioManager.OnModeChangedListener modeListener;
    private AudioDeviceCallback deviceListener;
    private boolean resumed;
    private boolean routeHeld;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Before super.onCreate, which builds the bridge from this list.
        registerPlugin(ScreenDimPlugin.class);
        super.onCreate(savedInstanceState);
        // Android 15+ draws under the system bars whether asked or not; older
        // versions need the ask, or they keep opaque bars around the webview
        // and the app has two layouts to get right. Must follow super.onCreate:
        // this creates the window decor, and BridgeActivity only swaps the
        // launch theme for the app theme in there.
        EdgeToEdge.enable(this);
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
                if (mode == AudioManager.MODE_IN_COMMUNICATION) ensureRoute("mode change");
                else releaseRoute();
            };
            am.addOnModeChangedListener(getMainExecutor(), modeListener);
            deviceListener = new AudioDeviceCallback() {
                @Override
                public void onAudioDevicesAdded(AudioDeviceInfo[] added) {
                    ensureRoute("device added");
                }

                @Override
                public void onAudioDevicesRemoved(AudioDeviceInfo[] removed) {
                    ensureRoute("device removed");
                }
            };
            am.registerAudioDeviceCallback(deviceListener, null);
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        resumed = true;
        ensureRoute("resume");
    }

    @Override
    public void onPause() {
        resumed = false;
        super.onPause();
    }

    @Override
    public void onDestroy() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
            if (modeListener != null) am.removeOnModeChangedListener(modeListener);
            if (deviceListener != null) am.unregisterAudioDeviceCallback(deviceListener);
            releaseRoute();
        }
        super.onDestroy();
    }

    /**
     * In communication mode Android routes playback to the EARPIECE unless
     * someone asks for another device. The WebView asks once, when it opens the
     * mic; the audio service drops that request while the app is in the
     * background ("removeInactiveRouteClient"), and on resume the WebView gets
     * the mode back without re-asking. Every reply after a lock/unlock then
     * played out of the earpiece: quiet at the same slider, a clipped onset,
     * and the echo canceller's reference no longer matching the room
     * (meditation-pal-wxj5). So re-ask ourselves, for what the WebView would
     * pick (AudioRoutePolicy).
     *
     * Our request and the WebView's are separate clients of one uid, and the
     * newer one wins. That is why a headset has to be looked for here: the
     * earpiece is also what the service reports with Bluetooth headphones
     * connected and their call link not up (yet, or any more), and asking for
     * the speaker then took the session off the headphones and left the
     * system's output picker spinning, since it cannot move a call stream
     * (meditation-pal-4xkx).
     */
    private void ensureRoute(String why) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || !resumed) return;
        AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        if (am.getMode() != AudioManager.MODE_IN_COMMUNICATION) return;
        AudioDeviceInfo current = am.getCommunicationDevice();
        int currentType = current != null ? current.getType() : AudioDeviceInfo.TYPE_BUILTIN_EARPIECE;
        List<AudioDeviceInfo> available = am.getAvailableCommunicationDevices();
        int[] types = new int[available.size()];
        for (int i = 0; i < types.length; i++) types[i] = available.get(i).getType();
        int wanted = AudioRoutePolicy.choose(currentType, types);
        if (wanted == AudioRoutePolicy.LEAVE) {
            Log.d(TAG, "route on " + why + ": device type " + currentType + " - leaving it");
            return;
        }
        for (AudioDeviceInfo dev : available) {
            if (dev.getType() != wanted) continue;
            boolean ok = am.setCommunicationDevice(dev);
            routeHeld |= ok;
            Log.d(TAG, "route on " + why + ": type " + currentType + " -> " + wanted + (ok ? " ok" : " REFUSED"));
            return;
        }
    }

    /**
     * Give the request back once communication mode is over. Android 16 was
     * seen to drop an idle one after six seconds; nothing says 12 and 13 do,
     * and a Bluetooth request left standing is an open call link that degrades
     * every other app's playback on the headphones.
     */
    private void releaseRoute() {
        if (!routeHeld || Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return;
        routeHeld = false;
        ((AudioManager) getSystemService(Context.AUDIO_SERVICE)).clearCommunicationDevice();
        Log.d(TAG, "route released");
    }
}
