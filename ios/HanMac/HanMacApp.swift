import SwiftUI

@main
struct HanMacApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
                .ignoresSafeArea(.keyboard, edges: .bottom)
        }
    }
}
