import Capacitor
import UIKit
#if canImport(DeclaredAgeRange)
import DeclaredAgeRange
#endif

/// The native half of ui/src/age-tier.ts: the age range the App Store shares
/// for this account (dev-docs/age-tier.md). Every path resolves, never
/// rejects, and a failure is "unavailable": the page treats that as not
/// knowing. Until the App ID has the Declared Age Range capability, every call
/// throws and this answers "unavailable". Nothing here is logged.
@objc(AgeSignalsPlugin)
public class AgeSignalsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AgeSignalsPlugin"
    public let jsName = "AgeSignals"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "check", returnType: CAPPluginReturnPromise)
    ]

    @objc func check(_ call: CAPPluginCall) {
        let askWhereOptional = call.getBool("askWhereOptional") ?? false
        #if canImport(DeclaredAgeRange)
        if #available(iOS 26.2, *) {
            Task { @MainActor in
                call.resolve(await self.read(askWhereOptional: askWhereOptional))
            }
            return
        }
        #endif
        call.resolve(["status": "unavailable", "detail": "os"])
    }

    #if canImport(DeclaredAgeRange)
    @available(iOS 26.2, *)
    @MainActor
    private func read(askWhereOptional: Bool) async -> [String: Any] {
        do {
            let eligible = try await AgeRangeService.shared.isEligibleForAgeFeatures
            if !eligible && !askWhereOptional {
                return ["status": "notRequired"]
            }
            guard let viewController = bridge?.viewController else {
                return ["status": "unavailable", "detail": "no view controller"]
            }
            // Can present a system sheet.
            switch try await AgeRangeService.shared.requestAgeRange(ageGates: 13, 16, 18, in: viewController) {
            case .declinedSharing:
                return ["status": "notShared"]
            case .sharing(let range):
                var out: [String: Any] = ["status": "shared"]
                if let lower = range.lowerBound { out["ageLower"] = lower }
                if let upper = range.upperBound { out["ageUpper"] = upper }
                return out
            @unknown default:
                return ["status": "unavailable", "detail": "unknown response"]
            }
        } catch {
            return ["status": "unavailable", "detail": Self.describe(error)]
        }
    }

    @available(iOS 26.2, *)
    private static func describe(_ error: Error) -> String {
        if let ageError = error as? AgeRangeService.Error {
            return String(describing: ageError)
        }
        let ns = error as NSError
        return "\(ns.domain) \(ns.code)"
    }
    #endif
}
