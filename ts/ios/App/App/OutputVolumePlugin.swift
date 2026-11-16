import AVFoundation
import Capacitor

/// The native half of ui/src/output-volume.ts: how loud the phone is set, so a
/// session can say when its voice would go unheard. The page can't read it.
/// The ring/silent switch can't be read by anyone.
@objc(OutputVolumePlugin)
public class OutputVolumePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "OutputVolumePlugin"
    public let jsName = "OutputVolume"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "level", returnType: CAPPluginReturnPromise)
    ]

    @objc func level(_ call: CAPPluginCall) {
        let level = AVAudioSession.sharedInstance().outputVolume
        call.resolve([
            "level": level,
            "muted": level <= 0,
            "headphones": AudioRoutePlugin.connected(),
        ])
    }
}
