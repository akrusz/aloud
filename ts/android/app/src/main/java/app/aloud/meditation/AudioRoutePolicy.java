package app.aloud.meditation;

import android.media.AudioDeviceInfo;

/**
 * Where a communication-mode session should play. Apart from MainActivity so
 * the choice runs in a plain unit test, with no audio service behind it.
 */
final class AudioRoutePolicy {
    static final int LEAVE = -1;

    private AudioRoutePolicy() {}

    /**
     * Lower is better: the WebView's own order when it opens the mic (wired,
     * then Bluetooth, then the speaker), with the earpiece last because nobody
     * holds the phone to an ear in a session. -1 is a route we neither pick nor
     * move off: a dock, HDMI, a USB interface, something set up on purpose.
     */
    static int rank(int type) {
        switch (type) {
            case AudioDeviceInfo.TYPE_WIRED_HEADSET:
            case AudioDeviceInfo.TYPE_WIRED_HEADPHONES:
            case AudioDeviceInfo.TYPE_USB_HEADSET:
                return 0;
            case AudioDeviceInfo.TYPE_BLUETOOTH_SCO:
            case AudioDeviceInfo.TYPE_BLE_HEADSET:
            case AudioDeviceInfo.TYPE_HEARING_AID:
                return 1;
            case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER:
                return 2;
            case AudioDeviceInfo.TYPE_BUILTIN_EARPIECE:
                return 3;
            default:
                return -1;
        }
    }

    /**
     * The device type to ask for, or LEAVE when the current one is as good as
     * anything on offer. {@code currentType} is what getCommunicationDevice
     * reports, {@code availableTypes} what getAvailableCommunicationDevices
     * lists.
     */
    static int choose(int currentType, int[] availableTypes) {
        int currentRank = rank(currentType);
        if (currentRank < 0) return LEAVE;
        int best = LEAVE;
        int bestRank = rank(AudioDeviceInfo.TYPE_BUILTIN_EARPIECE);
        for (int type : availableTypes) {
            int r = rank(type);
            if (r >= 0 && r < bestRank) {
                best = type;
                bestRank = r;
            }
        }
        return bestRank < currentRank ? best : LEAVE;
    }
}
