import SwiftUI

@main
struct WoodshedApp: App {
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
