package com.slayer.assurance;

import android.os.Bundle;
import android.webkit.JavascriptInterface;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    getBridge().getWebView().getSettings().setMediaPlaybackRequiresUserGesture(false);
    getBridge().getWebView().addJavascriptInterface(new AssuranceAndroidBridge(), "AssuranceAndroid");
  }

  private class AssuranceAndroidBridge {
    @JavascriptInterface
    public void exitApp() {
      runOnUiThread(() -> {
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.LOLLIPOP) {
          finishAndRemoveTask();
        } else {
          finish();
        }
      });
    }
  }
}
