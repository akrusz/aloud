package app.aloud.meditation;

import android.app.Activity;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.tasks.Task;
import com.google.android.play.agesignals.AgeSignalsAccessRequest;
import com.google.android.play.agesignals.AgeSignalsAccessResult;
import com.google.android.play.agesignals.AgeSignalsException;
import com.google.android.play.agesignals.AgeSignalsManager;
import com.google.android.play.agesignals.AgeSignalsManagerFactory;
import com.google.android.play.agesignals.AgeSignalsRequest;
import com.google.android.play.agesignals.AgeSignalsResult;
import com.google.android.play.agesignals.ApplicableAgeFeaturesRequest;
import com.google.android.play.agesignals.ApplicableAgeFeaturesResult;
import com.google.android.play.agesignals.model.AgeSignalsErrorCode;
import com.google.android.play.agesignals.model.AgeSignalsStatus;
import com.google.android.play.agesignals.model.ApplicableAgeFeature;
import com.google.android.play.agesignals.model.SignificantChangeStatus;

import java.util.Set;

/**
 * The native half of ui/src/age-tier.ts: the age range Google Play shares for
 * this account (dev-docs/age-tier.md). Every path resolves, never rejects, and
 * a failure is "unavailable" with the error code: the page treats that as not
 * knowing. Nothing here is logged.
 */
@CapacitorPlugin(name = "AgeSignals")
public class AgeSignalsPlugin extends Plugin {
    @PluginMethod
    public void check(PluginCall call) {
        boolean askWhereOptional = call.getBoolean("askWhereOptional", false);
        try {
            AgeSignalsManager manager = AgeSignalsManagerFactory.create(getContext().getApplicationContext());
            manager.getApplicableAgeFeatures(ApplicableAgeFeaturesRequest.builder().build())
                .addOnCompleteListener(task -> {
                    if (!task.isSuccessful()) {
                        unavailable(call, task);
                        return;
                    }
                    Set<Integer> features = task.getResult().features();
                    boolean mandatory = features != null && features.contains(ApplicableAgeFeature.MANDATORY_SHARING);
                    if (mandatory || askWhereOptional) requestAccess(call, manager);
                    // Never prompts: whatever this account already shares.
                    else readSignals(call, manager, false);
                });
        } catch (Exception e) {
            resolveUnavailable(call, describe(e));
        }
    }

    /** Where sharing is optional this can show Play's prompt; where the law
     *  makes it mandatory there is none. */
    private void requestAccess(PluginCall call, AgeSignalsManager manager) {
        Activity activity = getActivity();
        if (activity == null) {
            resolveUnavailable(call, "no activity");
            return;
        }
        try {
            manager.requestAgeSignalsAccess(AgeSignalsAccessRequest.builder().setActivity(activity).build())
                .addOnCompleteListener(task -> {
                    if (!task.isSuccessful()) {
                        unavailable(call, task);
                        return;
                    }
                    AgeSignalsAccessResult access = task.getResult();
                    Integer status = access == null ? null : access.ageSignalsStatus();
                    if (status == null) {
                        resolveUnavailable(call, "no status");
                    } else if (status == AgeSignalsStatus.SHARED) {
                        readSignals(call, manager, true);
                    } else if (status == AgeSignalsStatus.NOT_SHARED) {
                        resolveStatus(call, "notShared");
                    } else if (status == AgeSignalsStatus.VERIFICATION_REQUIRED) {
                        resolveStatus(call, "verificationRequired");
                    } else {
                        resolveUnavailable(call, "status " + status);
                    }
                });
        } catch (Exception e) {
            resolveUnavailable(call, describe(e));
        }
    }

    private void readSignals(PluginCall call, AgeSignalsManager manager, boolean accessGranted) {
        try {
            manager.checkAgeSignals(AgeSignalsRequest.builder().build())
                .addOnCompleteListener(task -> {
                    if (!task.isSuccessful()) {
                        unavailable(call, task);
                        return;
                    }
                    AgeSignalsResult result = task.getResult();
                    Integer lower = result == null ? null : result.ageLower();
                    Integer upper = result == null ? null : result.ageUpper();
                    if (!accessGranted && lower == null && upper == null) {
                        resolveStatus(call, "notRequired");
                        return;
                    }
                    JSObject out = new JSObject();
                    out.put("status", "shared");
                    out.put("ageLower", lower == null ? JSObject.NULL : lower);
                    out.put("ageUpper", upper == null ? JSObject.NULL : upper);
                    out.put("consent", consent(result == null ? null : result.significantChangeStatus()));
                    call.resolve(out);
                });
        } catch (Exception e) {
            resolveUnavailable(call, describe(e));
        }
    }

    private static Object consent(Integer status) {
        if (status == null) return JSObject.NULL;
        switch (status) {
            case SignificantChangeStatus.APPROVED:
                return "approved";
            case SignificantChangeStatus.PENDING:
                return "pending";
            case SignificantChangeStatus.DECLINED:
                return "declined";
            default:
                return JSObject.NULL;
        }
    }

    private static void resolveStatus(PluginCall call, String status) {
        JSObject out = new JSObject();
        out.put("status", status);
        call.resolve(out);
    }

    private static void resolveUnavailable(PluginCall call, String detail) {
        JSObject out = new JSObject();
        out.put("status", "unavailable");
        out.put("detail", detail);
        call.resolve(out);
    }

    private static void unavailable(PluginCall call, Task<?> task) {
        Exception e = task.getException();
        resolveUnavailable(call, e == null ? "failed" : describe(e));
    }

    private static String describe(Exception e) {
        if (!(e instanceof AgeSignalsException)) return e.getClass().getSimpleName();
        int code = ((AgeSignalsException) e).getErrorCode();
        return errorName(code) + " (" + code + ")";
    }

    private static String errorName(int code) {
        switch (code) {
            case AgeSignalsErrorCode.API_NOT_AVAILABLE: return "API_NOT_AVAILABLE";
            case AgeSignalsErrorCode.PLAY_STORE_NOT_FOUND: return "PLAY_STORE_NOT_FOUND";
            case AgeSignalsErrorCode.NETWORK_ERROR: return "NETWORK_ERROR";
            case AgeSignalsErrorCode.PLAY_SERVICES_NOT_FOUND: return "PLAY_SERVICES_NOT_FOUND";
            case AgeSignalsErrorCode.CANNOT_BIND_TO_SERVICE: return "CANNOT_BIND_TO_SERVICE";
            case AgeSignalsErrorCode.PLAY_STORE_VERSION_OUTDATED: return "PLAY_STORE_VERSION_OUTDATED";
            case AgeSignalsErrorCode.PLAY_SERVICES_VERSION_OUTDATED: return "PLAY_SERVICES_VERSION_OUTDATED";
            case AgeSignalsErrorCode.CLIENT_TRANSIENT_ERROR: return "CLIENT_TRANSIENT_ERROR";
            case AgeSignalsErrorCode.APP_NOT_OWNED: return "APP_NOT_OWNED";
            case AgeSignalsErrorCode.SDK_VERSION_OUTDATED: return "SDK_VERSION_OUTDATED";
            case AgeSignalsErrorCode.DEVICE_NOT_SUPPORTED: return "DEVICE_NOT_SUPPORTED";
            case AgeSignalsErrorCode.INTERNAL_ERROR: return "INTERNAL_ERROR";
            default: return "error";
        }
    }
}
