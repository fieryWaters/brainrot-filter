import SwiftUI
import SafariServices

struct ContentView: View {
    @EnvironmentObject var settings: AppSettings
    @State private var settingsUnlocked = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ExtensionStatusRow()
                }

                Section("Filter") {
                    Toggle("Enable filtering", isOn: $settings.isEnabled)
                    HStack {
                        Text("Threshold")
                        Spacer()
                        Text("\(Int(settings.threshold))/100")
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                    }
                }

                Section {
                    NavigationLink("Parental Controls") {
                        // If PIN is set, gate the settings screen behind it.
                        // Once unlocked, stays unlocked until user leaves ContentView.
                        if settings.pinEnabled && !settingsUnlocked {
                            PINEntryView(onSuccess: { settingsUnlocked = true })
                        } else {
                            SettingsView()
                                .onDisappear { settingsUnlocked = false }
                        }
                    }
                    NavigationLink("Advanced") {
                        AdvancedSettingsView()
                    }
                }
            }
            .navigationTitle("Brainrot Filter")
        }
    }
}

// Shows extension status and links to Safari settings if not enabled
struct ExtensionStatusRow: View {
    @State private var extensionEnabled = false

    // Replace with your actual extension bundle ID from Xcode
    private let extensionBundleID = "com.brainrotfilter.app.extension"

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: extensionEnabled ? "checkmark.shield.fill" : "shield.slash")
                .font(.title2)
                .foregroundStyle(extensionEnabled ? .green : .orange)

            VStack(alignment: .leading, spacing: 2) {
                Text(extensionEnabled ? "Extension active" : "Extension not enabled")
                    .font(.headline)
                Text(
                    extensionEnabled
                        ? "Running in Safari"
                        : "Enable in Settings → Safari → Extensions"
                )
                .font(.caption)
                .foregroundStyle(.secondary)
            }

            Spacer()

            if !extensionEnabled {
                Button("Enable") {
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
            }
        }
        .padding(.vertical, 4)
        .onAppear { checkExtensionState() }
    }

    private func checkExtensionState() {
        SFSafariExtensionManager.getStateOfSafariExtension(
            withIdentifier: extensionBundleID
        ) { state, _ in
            DispatchQueue.main.async {
                extensionEnabled = state?.isEnabled ?? false
            }
        }
    }
}
