package app.aloud.meditation;

import android.content.Context;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The native half of ui/src/output-volume.ts: how loud the phone is set, so a
 * session can say when its voice would go unheard. The page can't read it.
 */
@CapacitorPlugin(name = "OutputVolume")
public class OutputVolumePlugin extends Plugin {
    @PluginMethod
    public void level(PluginCall call) {
        AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        // An echo-cancelled capture puts the app in communication mode and its
        // voice on the call stream (MainActivity); otherwise it plays as media.
        int stream = am.getMode() == AudioManager.MODE_IN_COMMUNICATION
                ? AudioManager.STREAM_VOICE_CALL
                : AudioManager.STREAM_MUSIC;
        int volume = am.getStreamVolume(stream);
        int max = am.getStreamMaxVolume(stream);
        int min = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? am.getStreamMinVolume(stream) : 0;
        JSObject out = new JSObject();
        out.put("level", max > min ? (double) (volume - min) / (max - min) : 1.0);
        // The call stream's lowest step is above zero: quiet, never off.
        out.put("muted", volume == 0 || am.isStreamMute(stream));
        out.put("headphones", headphones(am));
        call.resolve(out);
    }

    /**
     * Connected, which is not quite "playing through": close enough for
     * holding back a hint. With Bluetooth in communication mode the stream
     * that counts is the hidden STREAM_BLUETOOTH_SCO, so the level read above
     * is the wrong one, and this is what keeps it from being acted on.
     */
    private static boolean headphones(AudioManager am) {
        for (AudioDeviceInfo dev : am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
            int type = dev.getType();
            if (type == AudioDeviceInfo.TYPE_WIRED_HEADSET
                    || type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES
                    || type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP
                    || type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
                    || type == AudioDeviceInfo.TYPE_USB_HEADSET) {
                return true;
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && type == AudioDeviceInfo.TYPE_BLE_HEADSET) {
                return true;
            }
        }
        return false;
    }
}
