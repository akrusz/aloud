package app.aloud.meditation;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * The native half of ui/src/file-export.ts. The WebView ignores a blob link's
 * download, so a file the page hands over goes through the system's save
 * picker instead: the user chooses Downloads, Drive, or wherever.
 */
@CapacitorPlugin(name = "FileExport")
public class FileExportPlugin extends Plugin {
    @PluginMethod
    public void save(PluginCall call) {
        String filename = call.getString("filename");
        if (filename == null || call.getString("text") == null) {
            call.reject("filename and text are required");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType(call.getString("mimeType", "application/octet-stream"))
            .putExtra(Intent.EXTRA_TITLE, filename);
        startActivityForResult(call, intent, "onSaveTargetPicked");
    }

    @ActivityCallback
    private void onSaveTargetPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Uri uri = result.getData() == null ? null : result.getData().getData();
        if (result.getResultCode() != Activity.RESULT_OK || uri == null) {
            resolveSaved(call, false);
            return;
        }
        String text = call.getString("text", "");
        // Off the main thread: the target can be a cloud provider, and a
        // session archive runs to megabytes.
        getBridge().execute(() -> {
            try (OutputStream out = getContext().getContentResolver().openOutputStream(uri)) {
                if (out == null) throw new java.io.IOException("no output stream for " + uri);
                out.write(text.getBytes(StandardCharsets.UTF_8));
                resolveSaved(call, true);
            } catch (Exception e) {
                call.reject("Could not write the file", e);
            }
        });
    }

    private static void resolveSaved(PluginCall call, boolean saved) {
        JSObject ret = new JSObject();
        ret.put("saved", saved);
        call.resolve(ret);
    }
}
