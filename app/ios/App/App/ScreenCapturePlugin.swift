import UIKit
import Capacitor

/// Tells the web app whether the screen is being recorded, mirrored or otherwise captured, so protected screens
/// (lectures, live classes, exams) can cover their content. iOS cannot block captures; privacy-screen only emits change
/// events, this also gives the current state when a screen opens or the app resumes. See core/secure-screen.ts.
@objc(ScreenCapturePlugin)
public class ScreenCapturePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ScreenCapturePlugin"
    public let jsName = "ScreenCapture"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isCaptured", returnType: CAPPluginReturnPromise)
    ]

    @objc func isCaptured(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            call.resolve(["captured": self.captured()])
        }
    }

    private func captured() -> Bool {
        if #available(iOS 17.0, *), let scene = bridge?.viewController?.view.window?.windowScene {
            return scene.traitCollection.sceneCaptureState == .active
        }
        return UIScreen.main.isCaptured
    }
}
