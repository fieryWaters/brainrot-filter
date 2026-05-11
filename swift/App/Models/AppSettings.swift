import Foundation
import Combine

// Shared settings between the app UI and the Safari extension.
// Stored in an App Group UserDefaults so both targets can read/write.
// The App Group identifier must match the one configured in Xcode → Signing & Capabilities.
class AppSettings: ObservableObject {
    static let shared = AppSettings()

    // MARK: - Published properties (auto-persist on change)

    @Published var threshold: Double {
        didSet { defaults.set(Int(threshold), forKey: Keys.threshold) }
    }
    @Published var action: FilterAction {
        didSet { defaults.set(action.rawValue, forKey: Keys.action) }
    }
    @Published var allowOverride: Bool {
        didSet { defaults.set(allowOverride, forKey: Keys.allowOverride) }
    }
    @Published var isEnabled: Bool {
        didSet { defaults.set(isEnabled, forKey: Keys.isEnabled) }
    }
    @Published var serverURL: String {
        didSet { defaults.set(serverURL, forKey: Keys.serverURL) }
    }
    @Published var pinEnabled: Bool {
        didSet { defaults.set(pinEnabled, forKey: Keys.pinEnabled) }
    }
    @Published var pin: String {
        didSet { defaults.set(pin, forKey: Keys.pin) }
    }

    // MARK: - Types

    enum FilterAction: String, CaseIterable, Identifiable {
        case blur  = "blur"
        case block = "block"

        var id: String { rawValue }

        var label: String {
            switch self {
            case .blur:  return "Blur"
            case .block: return "Block"
            }
        }

        var description: String {
            switch self {
            case .blur:  return "Video is blurred; user can tap to watch anyway."
            case .block: return "Video is paused and fully covered."
            }
        }
    }

    // MARK: - Private

    // Replace this with your actual App Group ID from Xcode → Signing & Capabilities → App Groups
    static let appGroupID = "group.com.brainrotfilter.app"

    private let defaults: UserDefaults

    private enum Keys {
        static let threshold    = "threshold"
        static let action       = "action"
        static let allowOverride = "allowOverride"
        static let isEnabled    = "isEnabled"
        static let serverURL    = "serverURL"
        static let pinEnabled   = "pinEnabled"
        static let pin          = "pin"
    }

    private init() {
        defaults = UserDefaults(suiteName: AppSettings.appGroupID) ?? .standard

        let savedThreshold = defaults.integer(forKey: Keys.threshold)
        threshold    = savedThreshold > 0 ? Double(savedThreshold) : 70.0
        action       = FilterAction(rawValue: defaults.string(forKey: Keys.action) ?? "") ?? .blur
        allowOverride = defaults.object(forKey: Keys.allowOverride) as? Bool ?? true
        isEnabled    = defaults.bool(forKey: Keys.isEnabled)
        serverURL    = defaults.string(forKey: Keys.serverURL) ?? "http://localhost:8787"
        pinEnabled   = defaults.bool(forKey: Keys.pinEnabled)
        pin          = defaults.string(forKey: Keys.pin) ?? ""
    }
}
