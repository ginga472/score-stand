import SwiftUI

@main
struct PianoPracticeApp: App {
    var body: some Scene {
        WindowGroup {
            PracticeView()
                .ignoresSafeArea()
                .statusBarHidden(true)
                .persistentSystemOverlays(.hidden)
                .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
        }
    }
}
