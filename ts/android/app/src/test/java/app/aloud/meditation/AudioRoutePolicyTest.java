package app.aloud.meditation;

import static android.media.AudioDeviceInfo.TYPE_BLUETOOTH_A2DP;
import static android.media.AudioDeviceInfo.TYPE_BLUETOOTH_SCO;
import static android.media.AudioDeviceInfo.TYPE_BUILTIN_EARPIECE;
import static android.media.AudioDeviceInfo.TYPE_BUILTIN_SPEAKER;
import static android.media.AudioDeviceInfo.TYPE_HDMI;
import static android.media.AudioDeviceInfo.TYPE_WIRED_HEADSET;
import static app.aloud.meditation.AudioRoutePolicy.LEAVE;
import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class AudioRoutePolicyTest {
    private static final int[] PHONE = {TYPE_BUILTIN_EARPIECE, TYPE_BUILTIN_SPEAKER};
    private static final int[] PHONE_AND_BLUETOOTH = {TYPE_BUILTIN_EARPIECE, TYPE_BUILTIN_SPEAKER, TYPE_BLUETOOTH_SCO};
    private static final int[] PHONE_AND_BOTH = {
        TYPE_BUILTIN_EARPIECE, TYPE_BUILTIN_SPEAKER, TYPE_BLUETOOTH_SCO, TYPE_WIRED_HEADSET
    };

    @Test
    public void earpieceGoesToTheSpeakerOnABarePhone() {
        // meditation-pal-wxj5: quiet replies after a lock/unlock.
        assertEquals(TYPE_BUILTIN_SPEAKER, AudioRoutePolicy.choose(TYPE_BUILTIN_EARPIECE, PHONE));
    }

    @Test
    public void earpieceGoesToTheHeadsetWhenOneIsConnected() {
        // meditation-pal-4xkx: the speaker here took the session off the
        // user's headphones.
        assertEquals(TYPE_BLUETOOTH_SCO, AudioRoutePolicy.choose(TYPE_BUILTIN_EARPIECE, PHONE_AND_BLUETOOTH));
    }

    @Test
    public void aHeadsetConnectedMidSessionTakesOverFromTheSpeaker() {
        assertEquals(TYPE_BLUETOOTH_SCO, AudioRoutePolicy.choose(TYPE_BUILTIN_SPEAKER, PHONE_AND_BLUETOOTH));
    }

    @Test
    public void wiredBeatsBluetooth() {
        assertEquals(TYPE_WIRED_HEADSET, AudioRoutePolicy.choose(TYPE_BUILTIN_EARPIECE, PHONE_AND_BOTH));
        assertEquals(TYPE_WIRED_HEADSET, AudioRoutePolicy.choose(TYPE_BLUETOOTH_SCO, PHONE_AND_BOTH));
    }

    @Test
    public void theBestRouteOnOfferIsLeftAlone() {
        assertEquals(LEAVE, AudioRoutePolicy.choose(TYPE_BUILTIN_SPEAKER, PHONE));
        assertEquals(LEAVE, AudioRoutePolicy.choose(TYPE_BLUETOOTH_SCO, PHONE_AND_BLUETOOTH));
        assertEquals(LEAVE, AudioRoutePolicy.choose(TYPE_WIRED_HEADSET, PHONE_AND_BOTH));
    }

    @Test
    public void aRouteWeDoNotRankIsLeftAlone() {
        assertEquals(LEAVE, AudioRoutePolicy.choose(TYPE_HDMI, PHONE_AND_BLUETOOTH));
    }

    @Test
    public void nothingBetterThanTheEarpieceMeansNoRequest() {
        assertEquals(LEAVE, AudioRoutePolicy.choose(TYPE_BUILTIN_EARPIECE, new int[] {TYPE_BUILTIN_EARPIECE}));
        // A2DP is not a call route, so it is never a candidate.
        assertEquals(LEAVE, AudioRoutePolicy.choose(TYPE_BUILTIN_EARPIECE, new int[] {TYPE_BLUETOOTH_A2DP}));
    }
}
