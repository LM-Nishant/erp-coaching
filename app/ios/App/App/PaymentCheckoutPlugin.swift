import UIKit
import WebKit
import Capacitor

/// Keeps a payment gateway's checkout inside the app while it is open, and hands UPI payments to the payer's UPI apps.
/// See core/payment-checkout.ts.
///
/// Capacitor opens pages outside the app in Safari. Between begin() and the return to the app (at most 30 minutes) the
/// gateway's pages stay in the WebView, so the gateway's redirect brings the payer back to the app, and links to other
/// apps (UPI and bank apps) open those apps. Capacitor's bridge script runs in any top-level page, so native calls are
/// only accepted from the app's own pages (BridgeMessageGate).
@objc(PaymentCheckoutPlugin)
public class PaymentCheckoutPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PaymentCheckoutPlugin"
    public let jsName = "PaymentCheckout"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "begin", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "end", returnType: CAPPluginReturnPromise)
    ]

    private static let maxActive: TimeInterval = 30 * 60
    /// When the checkout opened; nil when none is open. Main thread only.
    private var activeSince: Date?
    private var appOrigins: [URL] = []

    override public func load() {
        guard let capacitor = bridge as? CapacitorBridge else { return }
        appOrigins = [capacitor.config.localURL, capacitor.config.serverURL]
        let delegation = capacitor.webViewDelegationHandler
        let gate = BridgeMessageGate(handler: delegation, appOrigins: appOrigins)
        delegation.contentController.removeScriptMessageHandler(forName: BridgeMessageGate.name)
        delegation.contentController.add(gate, name: BridgeMessageGate.name)
    }

    @objc func begin(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.activeSince = Date()
            call.resolve()
        }
    }

    @objc func end(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.activeSince = nil
            call.resolve()
        }
    }

    private var isActive: Bool {
        guard let since = activeSince else { return false }
        if Date().timeIntervalSince(since) > Self.maxActive {
            activeSince = nil
            return false
        }
        return true
    }

    override public func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        guard isActive, let url = navigationAction.request.url else { return nil }
        if BridgeMessageGate.matches(url: url, origins: appOrigins) {
            // Back in the app.
            activeSince = nil
            return nil
        }
        switch url.scheme?.lowercased() ?? "" {
        case "http", "https":
            // New windows still open in Safari.
            return navigationAction.targetFrame == nil ? nil : false
        case "", "about", "data", "blob", "javascript", "file":
            return nil
        default:
            if bridge?.webView?.window?.windowScene?.activationState == .foregroundActive {
                UIApplication.shared.open(url, options: [:], completionHandler: nil)
            }
            return true
        }
    }
}

/// Passes native calls to Capacitor only from the app's own pages, never from a gateway's or bank's page.
final class BridgeMessageGate: NSObject, WKScriptMessageHandler {
    static let name = "bridge"

    private weak var handler: WKScriptMessageHandler?
    private let appOrigins: [URL]

    init(handler: WKScriptMessageHandler, appOrigins: [URL]) {
        self.handler = handler
        self.appOrigins = appOrigins
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        let frame = message.frameInfo
        let fromApp = frame.request.url.map { Self.matches(url: $0, origins: appOrigins) } == true
            || Self.matches(origin: frame.securityOrigin, origins: appOrigins)
        guard fromApp else {
            CAPLog.print("⚡️  PaymentCheckout: ignored a native call from \(frame.securityOrigin.host)")
            return
        }
        handler?.userContentController(userContentController, didReceive: message)
    }

    static func matches(url: URL, origins: [URL]) -> Bool {
        origins.contains { same(scheme: url.scheme, host: url.host, port: url.port, as: $0) }
    }

    static func matches(origin: WKSecurityOrigin, origins: [URL]) -> Bool {
        origins.contains {
            same(scheme: origin.protocol, host: origin.host, port: origin.port == 0 ? nil : origin.port, as: $0)
        }
    }

    private static func same(scheme: String?, host: String?, port: Int?, as app: URL) -> Bool {
        guard let scheme = scheme, let host = host, !host.isEmpty else { return false }
        return scheme.caseInsensitiveCompare(app.scheme ?? "") == .orderedSame
            && host.caseInsensitiveCompare(app.host ?? "") == .orderedSame
            && effectivePort(port, scheme) == effectivePort(app.port, app.scheme)
    }

    private static func effectivePort(_ port: Int?, _ scheme: String?) -> Int? {
        if let port = port { return port }
        switch scheme?.lowercased() {
        case "http": return 80
        case "https": return 443
        default: return nil
        }
    }
}
