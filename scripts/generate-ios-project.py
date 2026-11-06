#!/usr/bin/env python3
"""
HanMac Document (한맥 문서) iOS / iPadOS Xcode Project Generator
Generates ios/HanMac.xcodeproj and Swift sources that host the built HanMac renderer
in a native iPadOS / iOS WKWebView with native file import/export and PDF printing.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IOS_DIR = ROOT / "ios"
APP_DIR = IOS_DIR / "HanMac"
WEB_SRC_DIR = ROOT / "out" / "renderer"
WEB_DST_DIR = APP_DIR / "Web"
ASSETS_DIR = APP_DIR / "Assets.xcassets"
ICON_SRC = ROOT / "resources" / "icon.png"
PROJ_DIR = IOS_DIR / "HanMac.xcodeproj"


def pb_id(label: str) -> str:
    return hashlib.sha1(f"hanmac.ios.{label}".encode("utf-8")).hexdigest()[:24].upper()


def write_swift_sources() -> None:
    APP_DIR.mkdir(parents=True, exist_ok=True)

    (APP_DIR / "HanMacApp.swift").write_text(
        """import SwiftUI

@main
struct HanMacApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
                .ignoresSafeArea(.keyboard, edges: .bottom)
        }
    }
}
""",
        encoding="utf-8",
    )

    (APP_DIR / "ContentView.swift").write_text(
        """import SwiftUI
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
            .replacingOccurrences(of: "\\\\", with: "\\\\\\\\")
            .replacingOccurrences(of: "'", with: "\\\\'")
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

        let docHtml = \"\"\"
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
        <body>\\(bodyHtml)</body>
        </html>
        \"\"\"
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
""",
        encoding="utf-8",
    )

    (APP_DIR / "Info.plist").write_text(
        """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>ko</string>
	<key>CFBundleDisplayName</key>
	<string>한맥 문서</string>
	<key>CFBundleExecutable</key>
	<string>$(EXECUTABLE_NAME)</string>
	<key>CFBundleIdentifier</key>
	<string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>한맥 문서</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>0.1.0</string>
	<key>CFBundleVersion</key>
	<string>1</string>
	<key>LSRequiresIPhoneOS</key>
	<true/>
	<key>LSSupportsOpeningDocumentsInPlace</key>
	<true/>
	<key>UISupportsDocumentBrowser</key>
	<false/>
	<key>UIApplicationSceneManifest</key>
	<dict>
		<key>UIApplicationSupportsMultipleScenes</key>
		<true/>
	</dict>
	<key>UILaunchScreen</key>
	<dict>
		<key>UIColorName</key>
		<string></string>
	</dict>
	<key>UISupportedInterfaceOrientations</key>
	<array>
		<string>UIInterfaceOrientationPortrait</string>
		<string>UIInterfaceOrientationLandscapeLeft</string>
		<string>UIInterfaceOrientationLandscapeRight</string>
	</array>
	<key>UISupportedInterfaceOrientations~ipad</key>
	<array>
		<string>UIInterfaceOrientationPortrait</string>
		<string>UIInterfaceOrientationPortraitUpsideDown</string>
		<string>UIInterfaceOrientationLandscapeLeft</string>
		<string>UIInterfaceOrientationLandscapeRight</string>
	</array>
	<key>NSAppTransportSecurity</key>
	<dict>
		<key>NSAllowsLocalNetworking</key>
		<true/>
		<key>NSAllowsArbitraryLoads</key>
		<true/>
	</dict>
	<key>CFBundleDocumentTypes</key>
	<array>
		<dict>
			<key>CFBundleTypeName</key>
			<string>HWPX Document</string>
			<key>LSHandlerRank</key>
			<string>Alternate</string>
			<key>LSItemContentTypes</key>
			<array>
				<string>public.data</string>
				<string>public.content</string>
			</array>
		</dict>
	</array>
</dict>
</plist>
""",
        encoding="utf-8",
    )


def copy_web_bundle() -> None:
    if WEB_DST_DIR.exists():
        shutil.rmtree(WEB_DST_DIR)
    shutil.copytree(WEB_SRC_DIR, WEB_DST_DIR)
    for map_file in WEB_DST_DIR.rglob("*.map"):
        map_file.unlink()

    # Inline CSS and JS into Web/index.html so WKWebView loads it with zero file:// CORS issues
    index_path = WEB_DST_DIR / "index.html"
    assets_dir = WEB_DST_DIR / "assets"
    css_files = sorted(assets_dir.glob("*.css"))
    js_files = sorted(assets_dir.glob("*.js"))
    css_text = "\n".join(f.read_text(encoding="utf-8") for f in css_files)
    js_text = "\n".join(f.read_text(encoding="utf-8") for f in js_files)
    # Escape closing script tags inside JS string literals if any
    safe_js = js_text.replace("</script", "<\\/script")

    inline_html = (
        '<!doctype html><html lang="ko"><head><meta charset="UTF-8" />'
        '<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />'
        "<title>한맥 문서</title><style>"
        + css_text
        + "</style></head><body><div id=\"root\"></div><script type=\"module\">"
        + safe_js
        + "</script></body></html>"
    )
    index_path.write_text(inline_html, encoding="utf-8")
    shutil.rmtree(assets_dir, ignore_errors=True)


def generate_app_icons() -> None:
    iconset = ASSETS_DIR / "AppIcon.appiconset"
    iconset.mkdir(parents=True, exist_ok=True)
    (ASSETS_DIR / "Contents.json").write_text(
        json.dumps({"info": {"author": "xcode", "version": 1}}, indent=2),
        encoding="utf-8",
    )

    specs = [
        ("iphone", "20x20", "2x", 40, "Icon-40.png"),
        ("iphone", "20x20", "3x", 60, "Icon-60.png"),
        ("iphone", "29x29", "2x", 58, "Icon-58.png"),
        ("iphone", "29x29", "3x", 87, "Icon-87.png"),
        ("iphone", "40x40", "2x", 80, "Icon-80.png"),
        ("iphone", "40x40", "3x", 120, "Icon-120.png"),
        ("iphone", "60x60", "2x", 120, "Icon-120-2.png"),
        ("iphone", "60x60", "3x", 180, "Icon-180.png"),
        ("ipad", "20x20", "1x", 20, "Icon-20.png"),
        ("ipad", "20x20", "2x", 40, "Icon-40-ipad.png"),
        ("ipad", "29x29", "1x", 29, "Icon-29.png"),
        ("ipad", "29x29", "2x", 58, "Icon-58-ipad.png"),
        ("ipad", "40x40", "1x", 40, "Icon-40-ipad2.png"),
        ("ipad", "40x40", "2x", 80, "Icon-80-ipad.png"),
        ("ipad", "76x76", "1x", 76, "Icon-76.png"),
        ("ipad", "76x76", "2x", 152, "Icon-152.png"),
        ("ipad", "83.5x83.5", "2x", 167, "Icon-167.png"),
        ("ios-marketing", "1024x1024", "1x", 1024, "Icon-1024.png"),
    ]

    images = []
    for idiom, size_str, scale, px, filename in specs:
        target = iconset / filename
        subprocess.run(
            ["sips", "-z", str(px), str(px), str(ICON_SRC), "--out", str(target)],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        images.append(
            {
                "idiom": idiom,
                "size": size_str,
                "scale": scale,
                "filename": filename,
            }
        )

    (iconset / "Contents.json").write_text(
        json.dumps({"images": images, "info": {"author": "xcode", "version": 1}}, indent=2),
        encoding="utf-8",
    )


def generate_pbxproj() -> None:
    PROJ_DIR.mkdir(parents=True, exist_ok=True)

    app_swift_ref = pb_id("ref.HanMacApp.swift")
    content_swift_ref = pb_id("ref.ContentView.swift")
    assets_ref = pb_id("ref.Assets.xcassets")
    web_ref = pb_id("ref.Web")
    info_ref = pb_id("ref.Info.plist")
    product_ref = pb_id("ref.HanMac.app")

    app_swift_build = pb_id("build.HanMacApp.swift")
    content_swift_build = pb_id("build.ContentView.swift")
    assets_build = pb_id("build.Assets.xcassets")
    web_build = pb_id("build.Web")

    main_group = pb_id("group.main")
    app_group = pb_id("group.HanMac")
    products_group = pb_id("group.Products")

    sources_phase = pb_id("phase.sources")
    resources_phase = pb_id("phase.resources")
    frameworks_phase = pb_id("phase.frameworks")

    target_id = pb_id("target.HanMac")
    project_id = pb_id("project.HanMac")
    proj_config_list = pb_id("configList.project")
    target_config_list = pb_id("configList.target")
    proj_debug = pb_id("config.project.Debug")
    proj_release = pb_id("config.project.Release")
    target_debug = pb_id("config.target.Debug")
    target_release = pb_id("config.target.Release")

    pbx = f"""// !$*UTF8*$!
{{
	archiveVersion = 1;
	classes = {{
	}};
	objectVersion = 56;
	objects = {{

/* Begin PBXBuildFile section */
		{app_swift_build} /* HanMacApp.swift in Sources */ = {{isa = PBXBuildFile; fileRef = {app_swift_ref} /* HanMacApp.swift */; }};
		{content_swift_build} /* ContentView.swift in Sources */ = {{isa = PBXBuildFile; fileRef = {content_swift_ref} /* ContentView.swift */; }};
		{assets_build} /* Assets.xcassets in Resources */ = {{isa = PBXBuildFile; fileRef = {assets_ref} /* Assets.xcassets */; }};
		{web_build} /* Web in Resources */ = {{isa = PBXBuildFile; fileRef = {web_ref} /* Web */; }};
/* End PBXBuildFile section */

/* Begin PBXFileReference section */
		{app_swift_ref} /* HanMacApp.swift */ = {{isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = HanMacApp.swift; sourceTree = "<group>"; }};
		{content_swift_ref} /* ContentView.swift */ = {{isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ContentView.swift; sourceTree = "<group>"; }};
		{assets_ref} /* Assets.xcassets */ = {{isa = PBXFileReference; lastKnownFileType = folder.assetcatalog; path = Assets.xcassets; sourceTree = "<group>"; }};
		{web_ref} /* Web */ = {{isa = PBXFileReference; lastKnownFileType = folder; path = Web; sourceTree = "<group>"; }};
		{info_ref} /* Info.plist */ = {{isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = Info.plist; sourceTree = "<group>"; }};
		{product_ref} /* HanMac.app */ = {{isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = HanMac.app; sourceTree = BUILT_PRODUCTS_DIR; }};
/* End PBXFileReference section */

/* Begin PBXFrameworksBuildPhase section */
		{frameworks_phase} /* Frameworks */ = {{
			isa = PBXFrameworksBuildPhase;
			buildActionMask = 2147483647;
			files = (
			);
			runOnlyForDeploymentPostprocessing = 0;
		}};
/* End PBXFrameworksBuildPhase section */

/* Begin PBXGroup section */
		{main_group} = {{
			isa = PBXGroup;
			children = (
				{app_group} /* HanMac */,
				{products_group} /* Products */,
			);
			sourceTree = "<group>";
		}};
		{app_group} /* HanMac */ = {{
			isa = PBXGroup;
			children = (
				{app_swift_ref} /* HanMacApp.swift */,
				{content_swift_ref} /* ContentView.swift */,
				{assets_ref} /* Assets.xcassets */,
				{web_ref} /* Web */,
				{info_ref} /* Info.plist */,
			);
			path = HanMac;
			sourceTree = "<group>";
		}};
		{products_group} /* Products */ = {{
			isa = PBXGroup;
			children = (
				{product_ref} /* HanMac.app */,
			);
			name = Products;
			sourceTree = "<group>";
		}};
/* End PBXGroup section */

/* Begin PBXNativeTarget section */
		{target_id} /* HanMac */ = {{
			isa = PBXNativeTarget;
			buildConfigurationList = {target_config_list} /* Build configuration list for PBXNativeTarget "HanMac" */;
			buildPhases = (
				{sources_phase} /* Sources */,
				{frameworks_phase} /* Frameworks */,
				{resources_phase} /* Resources */,
			);
			buildRules = (
			);
			dependencies = (
			);
			name = HanMac;
			productName = HanMac;
			productReference = {product_ref} /* HanMac.app */;
			productType = "com.apple.product-type.application";
		}};
/* End PBXNativeTarget section */

/* Begin PBXProject section */
		{project_id} /* Project object */ = {{
			isa = PBXProject;
			attributes = {{
				BuildIndependentTargetsInParallel = 1;
				LastSwiftUpdateCheck = 1600;
				LastUpgradeCheck = 1600;
				TargetAttributes = {{
					{target_id} = {{
						CreatedOnToolsVersion = 16.0;
					}};
				}};
			}};
			buildConfigurationList = {proj_config_list} /* Build configuration list for PBXProject "HanMac" */;
			compatibilityVersion = "Xcode 14.0";
			developmentRegion = ko;
			hasScannedForEncodings = 0;
			knownRegions = (
				ko,
				en,
				Base,
			);
			mainGroup = {main_group};
			productRefGroup = {products_group} /* Products */;
			projectDirPath = "";
			projectRoot = "";
			targets = (
				{target_id} /* HanMac */,
			);
		}};
/* End PBXProject section */

/* Begin PBXResourcesBuildPhase section */
		{resources_phase} /* Resources */ = {{
			isa = PBXResourcesBuildPhase;
			buildActionMask = 2147483647;
			files = (
				{assets_build} /* Assets.xcassets in Resources */,
				{web_build} /* Web in Resources */,
			);
			runOnlyForDeploymentPostprocessing = 0;
		}};
/* End PBXResourcesBuildPhase section */

/* Begin PBXSourcesBuildPhase section */
		{sources_phase} /* Sources */ = {{
			isa = PBXSourcesBuildPhase;
			buildActionMask = 2147483647;
			files = (
				{app_swift_build} /* HanMacApp.swift in Sources */,
				{content_swift_build} /* ContentView.swift in Sources */,
			);
			runOnlyForDeploymentPostprocessing = 0;
		}};
/* End PBXSourcesBuildPhase section */

/* Begin XCBuildConfiguration section */
		{proj_debug} /* Debug */ = {{
			isa = XCBuildConfiguration;
			buildSettings = {{
				ALWAYS_SEARCH_USER_PATHS = NO;
				CLANG_ENABLE_MODULES = YES;
				CLANG_ENABLE_OBJC_ARC = YES;
				COPY_PHASE_STRIP = NO;
				DEBUG_INFORMATION_FORMAT = dwarf;
				ENABLE_STRICT_OBJC_MSGSEND = YES;
				GCC_DYNAMIC_NO_PIC = NO;
				GCC_OPTIMIZATION_LEVEL = 0;
				IPHONEOS_DEPLOYMENT_TARGET = 16.0;
				MTL_ENABLE_DEBUG_INFO = INCLUDE_SOURCE;
				ONLY_ACTIVE_ARCH = YES;
				SDKROOT = iphoneos;
				SWIFT_ACTIVE_COMPILATION_CONDITIONS = DEBUG;
				SWIFT_OPTIMIZATION_LEVEL = "-Onone";
				 SWIFT_VERSION = 5.0;
			}};
			name = Debug;
		}};
		{proj_release} /* Release */ = {{
			isa = XCBuildConfiguration;
			buildSettings = {{
				ALWAYS_SEARCH_USER_PATHS = NO;
				CLANG_ENABLE_MODULES = YES;
				CLANG_ENABLE_OBJC_ARC = YES;
				COPY_PHASE_STRIP = NO;
				DEBUG_INFORMATION_FORMAT = "dwarf-with-dsym";
				ENABLE_NS_ASSERTIONS = NO;
				ENABLE_STRICT_OBJC_MSGSEND = YES;
				IPHONEOS_DEPLOYMENT_TARGET = 16.0;
				MTL_ENABLE_DEBUG_INFO = NO;
				SDKROOT = iphoneos;
				SWIFT_COMPILATION_MODE = wholemodule;
				SWIFT_OPTIMIZATION_LEVEL = "-O";
				SWIFT_VERSION = 5.0;
				VALIDATE_PRODUCT = YES;
			}};
			name = Release;
		}};
		{target_debug} /* Debug */ = {{
			isa = XCBuildConfiguration;
			buildSettings = {{
				ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;
				CODE_SIGN_STYLE = Automatic;
				CURRENT_PROJECT_VERSION = 1;
				GENERATE_INFOPLIST_FILE = NO;
				INFOPLIST_FILE = HanMac/Info.plist;
				IPHONEOS_DEPLOYMENT_TARGET = 16.0;
				LD_RUNPATH_SEARCH_PATHS = (
					"$(inherited)",
					"@executable_path/Frameworks",
				);
				MARKETING_VERSION = 0.1.0;
				PRODUCT_BUNDLE_IDENTIFIER = com.hanmac.document.ipad;
				PRODUCT_NAME = "$(TARGET_NAME)";
				SUPPORTED_PLATFORMS = "iphoneos iphonesimulator";
				SUPPORTS_MACCATALYST = NO;
				TARGETED_DEVICE_FAMILY = "1,2";
			}};
			name = Debug;
		}};
		{target_release} /* Release */ = {{
			isa = XCBuildConfiguration;
			buildSettings = {{
				ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;
				CODE_SIGN_STYLE = Automatic;
				CURRENT_PROJECT_VERSION = 1;
				GENERATE_INFOPLIST_FILE = NO;
				INFOPLIST_FILE = HanMac/Info.plist;
				IPHONEOS_DEPLOYMENT_TARGET = 16.0;
				LD_RUNPATH_SEARCH_PATHS = (
					"$(inherited)",
					"@executable_path/Frameworks",
				);
				MARKETING_VERSION = 0.1.0;
				PRODUCT_BUNDLE_IDENTIFIER = com.hanmac.document.ipad;
				PRODUCT_NAME = "$(TARGET_NAME)";
				SUPPORTED_PLATFORMS = "iphoneos iphonesimulator";
				SUPPORTS_MACCATALYST = NO;
				TARGETED_DEVICE_FAMILY = "1,2";
			}};
			name = Release;
		}};
/* End XCBuildConfiguration section */

/* Begin XCConfigurationList section */
		{proj_config_list} /* Build configuration list for PBXProject "HanMac" */ = {{
			isa = XCConfigurationList;
			buildConfigurations = (
				{proj_debug} /* Debug */,
				{proj_release} /* Release */,
			);
			defaultConfigurationIsVisible = 0;
			defaultConfigurationName = Release;
		}};
		{target_config_list} /* Build configuration list for PBXNativeTarget "HanMac" */ = {{
			isa = XCConfigurationList;
			buildConfigurations = (
				{target_debug} /* Debug */,
				{target_release} /* Release */,
			);
			defaultConfigurationIsVisible = 0;
			defaultConfigurationName = Release;
		}};
/* End XCConfigurationList section */
	}};
	rootObject = {project_id} /* Project object */;
}}
"""
    (PROJ_DIR / "project.pbxproj").write_text(pbx, encoding="utf-8")


if __name__ == "__main__":
    write_swift_sources()
    copy_web_bundle()
    generate_app_icons()
    generate_pbxproj()
    print("✓ Generated ios/HanMac.xcodeproj and bundled Web assets.")
