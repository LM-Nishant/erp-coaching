import UIKit
import Capacitor

/// Root view controller: registers the app's own Capacitor plugins.
class AppViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(ScreenCapturePlugin())
    }
}
