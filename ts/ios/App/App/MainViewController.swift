import UIKit
import Capacitor

/// The storyboard's bridge view controller, subclassed only to register the
/// plugins that live in this app rather than in a package.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(FileExportPlugin())
        bridge?.registerPluginInstance(AudioRoutePlugin())
    }
}
