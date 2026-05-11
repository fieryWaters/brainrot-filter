import SwiftUI

// MARK: - Main parental controls screen

struct SettingsView: View {
    @EnvironmentObject var settings: AppSettings

    var body: some View {
        List {
            sensitivitySection
            actionSection
            parentalLockSection
        }
        .navigationTitle("Parental Controls")
        .navigationBarTitleDisplayMode(.inline)
    }

    // MARK: - Sections

    private var sensitivitySection: some View {
        Section {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("Threshold")
                    Spacer()
                    Text("\(Int(settings.threshold)) / 100")
                        .monospacedDigit()
                        .fontWeight(.semibold)
                        .foregroundStyle(thresholdColor)
                }
                Slider(value: $settings.threshold, in: 0...100, step: 5)
                    .tint(thresholdColor)
                Text(thresholdDescription)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.vertical, 4)
        } header: {
            Text("Sensitivity")
        } footer: {
            Text("Content that scores \(Int(settings.threshold)) or above is filtered. Lower = stricter.")
        }
    }

    private var actionSection: some View {
        Section("Action") {
            Picker("When flagged", selection: $settings.action) {
                ForEach(AppSettings.FilterAction.allCases) { action in
                    VStack(alignment: .leading) {
                        Text(action.label)
                        Text(action.description)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .tag(action)
                }
            }
            .pickerStyle(.inline)
            .labelsHidden()

            if settings.action == .blur {
                Toggle("Allow \"Watch anyway\"", isOn: $settings.allowOverride)
            }
        }
    }

    private var parentalLockSection: some View {
        Section {
            Toggle("Require PIN to change settings", isOn: $settings.pinEnabled)

            if settings.pinEnabled {
                NavigationLink("Change PIN") {
                    PINSetupView()
                }
            }
        } header: {
            Text("Parental Lock")
        } footer: {
            Text(
                settings.pinEnabled
                    ? "A PIN is required to open this screen."
                    : "Set a PIN so kids can't change these settings."
            )
        }
    }

    // MARK: - Helpers

    private var thresholdColor: Color {
        switch settings.threshold {
        case 0..<40:  return .red
        case 40..<60: return .orange
        case 60..<80: return .yellow
        default:      return .green
        }
    }

    private var thresholdDescription: String {
        switch settings.threshold {
        case 0..<40:  return "Strict — a lot of casual content will be caught"
        case 40..<60: return "Moderate — obvious brainrot is blocked"
        case 60..<80: return "Relaxed — only high-confidence slop filtered"
        default:      return "Permissive — only extreme content blocked"
        }
    }
}

// MARK: - PIN entry (shown when navigating to settings with PIN enabled)

struct PINEntryView: View {
    @EnvironmentObject var settings: AppSettings
    var onSuccess: () -> Void

    @State private var entered = ""
    @State private var failed  = false

    var body: some View {
        VStack(spacing: 28) {
            Spacer()

            Image(systemName: "lock.fill")
                .font(.system(size: 52))
                .foregroundStyle(.secondary)

            VStack(spacing: 8) {
                Text("Parental Controls")
                    .font(.title2.bold())
                Text("Enter your PIN to continue")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            SecureField("PIN", text: $entered)
                .textFieldStyle(.roundedBorder)
                .keyboardType(.numberPad)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 160)
                .onSubmit { attempt() }

            if failed {
                Text("Incorrect PIN")
                    .foregroundStyle(.red)
                    .font(.caption)
                    .transition(.opacity)
            }

            Button("Unlock", action: attempt)
                .buttonStyle(.borderedProminent)
                .disabled(entered.isEmpty)

            Spacer()
        }
        .padding()
        .navigationTitle("Parental Controls")
        .navigationBarTitleDisplayMode(.inline)
        .animation(.default, value: failed)
    }

    private func attempt() {
        if entered == settings.pin {
            onSuccess()
        } else {
            failed   = true
            entered  = ""
        }
    }
}

// MARK: - PIN setup

struct PINSetupView: View {
    @EnvironmentObject var settings: AppSettings
    @Environment(\.dismiss) var dismiss

    @State private var newPIN     = ""
    @State private var confirmPIN = ""
    @State private var mismatch   = false

    var body: some View {
        List {
            Section {
                SecureField("New PIN", text: $newPIN)
                    .keyboardType(.numberPad)
                SecureField("Confirm PIN", text: $confirmPIN)
                    .keyboardType(.numberPad)
            } footer: {
                if mismatch {
                    Text("PINs don't match")
                        .foregroundStyle(.red)
                }
            }

            Section {
                Button("Save PIN") {
                    guard !newPIN.isEmpty, newPIN == confirmPIN else {
                        mismatch = true
                        return
                    }
                    settings.pin = newPIN
                    dismiss()
                }
                .disabled(newPIN.isEmpty || confirmPIN.isEmpty)
            }
        }
        .navigationTitle("Set PIN")
        .navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: - Advanced settings (server URL, etc.)

struct AdvancedSettingsView: View {
    @EnvironmentObject var settings: AppSettings

    var body: some View {
        List {
            Section {
                TextField("Server URL", text: $settings.serverURL)
                    .keyboardType(.URL)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
            } header: {
                Text("Scoring Server")
            } footer: {
                Text(
                    "The brainrot scoring server. Use http://localhost:8787 for local dev; " +
                    "switch to your cloud URL before distributing."
                )
            }

            Section {
                Button("Reset to defaults", role: .destructive) {
                    settings.threshold     = 70
                    settings.action        = .blur
                    settings.allowOverride = true
                    settings.isEnabled     = true
                }
            }
        }
        .navigationTitle("Advanced")
        .navigationBarTitleDisplayMode(.inline)
    }
}
