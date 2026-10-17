import AVFoundation
import Capacitor

/// The native half of ui/src/audio-route.ts: whether the app's sound goes to
/// headphones. An iPhone's echo canceller lets the speaker through to the mic,
/// so a session keeps the mic shut while the facilitator speaks unless this
/// says headphones (meditation-pal-hi6f). The page can't see the output route.
@objc(AudioRoutePlugin)
public class AudioRoutePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AudioRoutePlugin"
    public let jsName = "AudioRoute"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "headphones", returnType: CAPPluginReturnPromise)
    ]

    /// Outputs the mic can't hear. A Bluetooth speaker reports as A2DP too,
    /// but on a phone that's nearly always earbuds. Car audio, AirPlay and
    /// line out are rooms.
    private static let headphonePorts: Set<AVAudioSession.Port> = [
        .headphones, .bluetoothA2DP, .bluetoothHFP, .bluetoothLE, .usbAudio,
    ]

    private static func connected() -> Bool {
        AVAudioSession.sharedInstance().currentRoute.outputs.contains {
            headphonePorts.contains($0.portType)
        }
    }

    public override func load() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(routeChanged),
            name: AVAudioSession.routeChangeNotification,
            object: nil
        )
    }

    @objc func headphones(_ call: CAPPluginCall) {
        call.resolve(["connected": Self.connected()])
    }

    @objc private func routeChanged(_ note: Notification) {
        notifyListeners("change", data: ["connected": Self.connected()])
    }
}
