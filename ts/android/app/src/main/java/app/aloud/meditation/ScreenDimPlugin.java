package app.aloud.meditation;

import android.view.Window;
import android.view.WindowManager;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The native half of ui/src/screen-dim.ts: while the page shows its black
 * cover, take this window's brightness down too. Black pixels are off on an
 * OLED panel either way; on an LCD only this dims the backlight.
 */
@CapacitorPlugin(name = "ScreenDim")
public class ScreenDimPlugin extends Plugin {
    // Just above 0 (BRIGHTNESS_OVERRIDE_OFF), which some devices take as the
    // backlight off outright.
    private static final float DIMMED = 0.01f;

    @PluginMethod
    public void setDimmed(PluginCall call) {
        boolean dimmed = Boolean.TRUE.equals(call.getBoolean("dimmed", false));
        getActivity().runOnUiThread(() -> {
            Window window = getActivity().getWindow();
            WindowManager.LayoutParams params = window.getAttributes();
            params.screenBrightness = dimmed ? DIMMED : WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE;
            window.setAttributes(params);
            call.resolve();
        });
    }
}
