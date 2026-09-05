package app.aloud.meditation;

import android.media.AudioManager;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // The WebView's WebRTC capture (hosted STT / VAD with echo cancellation)
        // puts Android in communication mode, and the volume keys then adjust
        // the CALL stream while the facilitator plays on media - the rocker
        // read "Call" mid-sit (meditation-pal-wxj5). Pin the keys to media.
        setVolumeControlStream(AudioManager.STREAM_MUSIC);
    }
}
