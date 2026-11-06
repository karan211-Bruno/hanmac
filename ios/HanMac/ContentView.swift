import SwiftUI
import WebKit
import UniformTypeIdentifiers
import UIKit

struct ContentView: View {
    @StateObject private var bridge = HanMacWebBridge()

    var body: some View {
        HanMacWebView(bridge: bridge)
            .background(Color(red: 0.925, green: 0.914, blue: 0.882))
            .onOpenURL { url in
                bridge.openExternalFile(url: url)
            }
    }
}

final class HanMacWebBridge: NSObject, ObservableObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    weak var webView: WKWebView?

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "hanmac",
              let body = message.body as? [String: Any],
              let action = body["action"] as? String else {
            return
        }

        switch action {
        case "saveFile":
            guard let filename = body["filename"] as? String,
                  let base64 = body["base64"] as? String,
                  let data = Data(base64Encoded: base64) else {
                return
            }
            DispatchQueue.main.async {
                self.presentExportFile(data: data, filename: filename)
            }

        case "exportPdf":
            let title = (body["title"] as? String) ?? "한맥 문서"
            let html = (body["html"] as? String) ?? ""
            DispatchQueue.main.async {
                self.presentPrintOrPdf(title: title, bodyHtml: html)
            }

        default:
            break
        }
    }

    func openExternalFile(url: URL) {
        let shouldStop = url.startAccessingSecurityScopedResource()
        defer {
            if shouldStop { url.stopAccessingSecurityScopedResource() }
        }
        guard let data = try? Data(contentsOf: url) else { return }
        let base64 = data.base64EncodedString()
        let fileName = url.lastPathComponent
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
        let js = "window.__hanmacNativeOpenBase64 && window.__hanmacNativeOpenBase64('\(base64)', '\(fileName)');"
        DispatchQueue.main.async {
            self.webView?.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    private func topViewController() -> UIViewController? {
        guard let scene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .first(where: { $0.activationState == .foregroundActive }) ?? UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
              let root = scene.windows.first(where: { $0.isKeyWindow })?.rootViewController ?? scene.windows.first?.rootViewController else {
            return nil
        }
        var current = root
        while let presented = current.presentedViewController {
            current = presented
        }
        return current
    }

    private func presentExportFile(data: Data, filename: String) {
        let tempURL = FileManager.default.temporaryDirectory.appendingPathComponent(filename)
        do {
            try data.write(to: tempURL, options: .atomic)
        } catch {
            return
        }
        guard let presenter = topViewController() else { return }
        let activity = UIActivityViewController(activityItems: [tempURL], applicationActivities: nil)
        if let popover = activity.popoverPresentationController {
            popover.sourceView = presenter.view
            popover.sourceRect = CGRect(x: presenter.view.bounds.midX, y: 60, width: 1, height: 1)
        }
        presenter.present(activity, animated: true)
    }

    private func presentPrintOrPdf(title: String, bodyHtml: String) {
        let printController = UIPrintInteractionController.shared
        let printInfo = UIPrintInfo(dictionary: nil)
        printInfo.outputType = .general
        printInfo.jobName = title
        printController.printInfo = printInfo

        let docHtml = """
        <!doctype html>
        <html lang="ko">
        <head>
        <meta charset="utf-8">
        <style>
          body { font-family: "Apple SD Gothic Neo", "AppleMyungjo", serif; font-size: 11pt; line-height: 1.78; color: #1f1d1a; margin: 20mm; }
          table { border-collapse: collapse; width: 100%; margin: 1em 0; }
          td, th { border: 1px solid #8d877c; padding: 6px 8px; }
          blockquote { border-left: 3px solid #a8432f; margin: 1em 0; padding-left: 1em; color: #4b463e; }
        </style>
        </head>
        <body>\(bodyHtml)</body>
        </html>
        """
        let formatter = UIMarkupTextPrintFormatter(markupText: docHtml)
        printController.printFormatter = formatter
        printController.present(animated: true, completionHandler: nil)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        guard let presenter = topViewController() else {
            completionHandler(true)
            return
        }
        let alert = UIAlertController(title: "한맥 문서", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "취소", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "확인", style: .destructive) { _ in completionHandler(true) })
        presenter.present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        guard let presenter = topViewController() else {
            completionHandler()
            return
        }
        let alert = UIAlertController(title: "한맥 문서", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "확인", style: .default) { _ in completionHandler() })
        presenter.present(alert, animated: true)
    }
}

struct HanMacWebView: UIViewRepresentable {
    @ObservedObject var bridge: HanMacWebBridge

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.userContentController.add(bridge, name: "hanmac")
        config.allowsInlineMediaPlayback = true
        config.preferences.javaScriptCanOpenWindowsAutomatically = false

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = bridge
        webView.uiDelegate = bridge
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 0.925, green: 0.914, blue: 0.882, alpha: 1.0)

        bridge.webView = webView

        if let indexURL = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "Web") {
            let webDir = indexURL.deletingLastPathComponent()
            webView.loadFileURL(indexURL, allowingReadAccessTo: webDir)
        }
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
