package com.assistfin.app;

import android.Manifest;
import android.app.NotificationManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.app.ActivityCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "RideOverlay")
public class RideOverlayPlugin extends Plugin {
    private boolean notificationAccessEnabled() {
        Context context = getContext();
        String flat = Settings.Secure.getString(context.getContentResolver(), "enabled_notification_listeners");
        if (flat == null) return false;
        ComponentName component = new ComponentName(context, RideNotificationListener.class);
        return flat.contains(component.flattenToString()) || flat.contains(context.getPackageName());
    }

    private JSObject status() {
        Context context = getContext();
        JSObject result = new JSObject();
        result.put("overlayPermission", Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(context));
        result.put("notificationAccess", notificationAccessEnabled());
        result.put("notificationsAllowed", NotificationManagerCompat.from(context).areNotificationsEnabled());
        result.put("running", context.getSharedPreferences(RideOverlayService.PREFS, Context.MODE_PRIVATE).getBoolean("enabled", false));
        return result;
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        call.resolve(status());
    }

    @PluginMethod
    public void openOverlaySettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
            Uri.parse("package:" + getContext().getPackageName()));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    @PluginMethod
    public void start(PluginCall call) {
        Context context = getContext();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(context)) {
            call.reject("overlay-permission");
            return;
        }
        if (Build.VERSION.SDK_INT >= 33 && ActivityCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(getActivity(), new String[]{Manifest.permission.POST_NOTIFICATIONS}, 914);
        }
        Intent intent = new Intent(context, RideOverlayService.class);
        intent.setAction(RideOverlayService.ACTION_START);
        intent.putExtra("costPerKm", call.getDouble("costPerKm", 0.0));
        intent.putExtra("minPerKm", call.getDouble("minPerKm", 0.0));
        ContextCompat.startForegroundService(context, intent);
        call.resolve(status());
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Intent intent = new Intent(getContext(), RideOverlayService.class);
        intent.setAction(RideOverlayService.ACTION_STOP);
        getContext().startService(intent);
        getContext().getSharedPreferences(RideOverlayService.PREFS, Context.MODE_PRIVATE)
            .edit().putBoolean("enabled", false).apply();
        call.resolve(status());
    }
}
