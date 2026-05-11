import SafariServices
import os.log

// Handles messages sent from the extension's background.js via browser.runtime.sendNativeMessage.
// Reads settings from the App Group UserDefaults so the extension always reflects the app's config.
class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    private let logger = Logger(subsystem: "com.brainrotfilter.app", category: "extension")

    func beginRequest(with context: NSExtensionContext) {
        guard
            let item    = context.inputItems.first as? NSExtensionItem,
            let message = item.userInfo?[SFExtensionMessageKey] as? [String: Any],
            let type    = message["type"] as? String
        else {
            context.completeRequest(returningItems: nil)
            return
        }

        let response = NSExtensionItem()

        switch type {
        case "getConfig":
            response.userInfo = [SFExtensionMessageKey: currentConfig()]
            logger.log("getConfig responded")

        default:
            logger.warning("unknown message type: \(type)")
            response.userInfo = [SFExtensionMessageKey: ["error": "unknown type"]]
        }

        context.completeRequest(returningItems: [response])
    }

    // MARK: - Private

    private func currentConfig() -> [String: Any] {
        let defaults  = UserDefaults(suiteName: AppSettings.appGroupID) ?? .standard
        let threshold = defaults.integer(forKey: "threshold")
        return [
            "threshold":     threshold > 0 ? threshold : 70,
            "action":        defaults.string(forKey: "action") ?? "blur",
            "allowOverride": defaults.object(forKey: "allowOverride") as? Bool ?? true,
            "isEnabled":     defaults.bool(forKey: "isEnabled"),
            "serverURL":     defaults.string(forKey: "serverURL") ?? "http://localhost:8787",
        ]
    }
}
