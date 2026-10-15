import UIKit
import Capacitor

/// The native half of ui/src/file-export.ts. WKWebView ignores a blob link's
/// download, so a file the page hands over goes out through the share sheet
/// instead, where Save to Files sits beside AirDrop and Mail.
@objc(FileExportPlugin)
public class FileExportPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "FileExportPlugin"
    public let jsName = "FileExport"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "save", returnType: CAPPluginReturnPromise)
    ]

    @objc func save(_ call: CAPPluginCall) {
        guard let filename = call.getString("filename"), let text = call.getString("text") else {
            call.reject("filename and text are required")
            return
        }
        // The shared item's name is the file's, so it keeps the one the page chose.
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(filename)
        do {
            try text.write(to: url, atomically: true, encoding: .utf8)
        } catch {
            call.reject("Could not write the file", nil, error)
            return
        }
        DispatchQueue.main.async {
            guard let host = self.bridge?.viewController else {
                try? FileManager.default.removeItem(at: url)
                call.reject("No view to present from")
                return
            }
            let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
            sheet.completionWithItemsHandler = { _, completed, _, _ in
                try? FileManager.default.removeItem(at: url)
                call.resolve(["saved": completed])
            }
            // iPad presents the sheet as a popover, which needs an anchor.
            if let popover = sheet.popoverPresentationController {
                popover.sourceView = host.view
                popover.sourceRect = CGRect(x: host.view.bounds.midX, y: host.view.bounds.midY, width: 0, height: 0)
                popover.permittedArrowDirections = []
            }
            host.present(sheet, animated: true)
        }
    }
}
