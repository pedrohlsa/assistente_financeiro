package com.assistfin.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.IBinder;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.core.app.NotificationCompat;

public class RideOverlayService extends Service {
    public static final String PREFS = "assistfin_ride_overlay";
    public static final String ACTION_START = "com.assistfin.app.overlay.START";
    public static final String ACTION_STOP = "com.assistfin.app.overlay.STOP";
    public static final String ACTION_UPDATE = "com.assistfin.app.overlay.UPDATE";
    private static final String CHANNEL_ID = "assistfin_ride_overlay";
    private static final int NOTIFICATION_ID = 7199;

    private WindowManager windowManager;
    private View overlay;
    private TextView content;
    private WindowManager.LayoutParams params;

    private final BroadcastReceiver updateReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            if (ACTION_UPDATE.equals(intent.getAction()) && content != null) {
                content.setText(intent.getStringExtra("text"));
            }
        }
    };

    @Override public void onCreate() {
        super.onCreate();
        IntentFilter filter = new IntentFilter(ACTION_UPDATE);
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(updateReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        else registerReceiver(updateReceiver, filter);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("enabled", false).apply();
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return START_NOT_STICKY;
        }

        if (intent != null && ACTION_START.equals(intent.getAction())) {
            getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                .putBoolean("enabled", true)
                .putFloat("costPerKm", (float) intent.getDoubleExtra("costPerKm", 0.0))
                .putFloat("minPerKm", (float) intent.getDoubleExtra("minPerKm", 0.0))
                .apply();
        }
        createChannel();
        Notification notification = buildNotification();
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
        showOverlay();
        return START_STICKY;
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Analisador flutuante", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Mantém o painel de corridas visível quando você ativa o recurso.");
        getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    private Notification buildNotification() {
        Intent open = new Intent(this, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pending = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_compass)
            .setContentTitle("AssistFin flutuante ativo")
            .setContentText("Toque para voltar ao app.")
            .setOngoing(true)
            .setContentIntent(pending)
            .build();
    }

    private GradientDrawable background() {
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.rgb(24, 96, 77));
        bg.setCornerRadius(dp(18));
        bg.setStroke(dp(1), Color.argb(90, 255, 255, 255));
        return bg;
    }

    private void showOverlay() {
        if (overlay != null) return;
        windowManager = (WindowManager) getSystemService(WINDOW_SERVICE);
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(dp(14), dp(10), dp(14), dp(10));
        panel.setBackground(background());

        TextView title = new TextView(this);
        title.setText("✦ AssistFin");
        title.setTextColor(Color.WHITE);
        title.setTextSize(14);
        title.setTypeface(null, android.graphics.Typeface.BOLD);
        panel.addView(title);

        content = new TextView(this);
        content.setText("Aguardando uma oferta da Uber, 99 ou inDrive…");
        content.setTextColor(Color.WHITE);
        content.setTextSize(12);
        content.setMaxWidth(dp(270));
        content.setPadding(0, dp(3), 0, 0);
        panel.addView(content);

        params = new WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            Build.VERSION.SDK_INT >= 26 ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY : WindowManager.LayoutParams.TYPE_PHONE,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT
        );
        params.gravity = Gravity.TOP | Gravity.END;
        params.x = dp(10);
        params.y = dp(110);

        final float[] down = new float[4];
        panel.setOnTouchListener((v, event) -> {
            if (event.getAction() == MotionEvent.ACTION_DOWN) {
                down[0] = event.getRawX(); down[1] = event.getRawY();
                down[2] = params.x; down[3] = params.y;
                return true;
            }
            if (event.getAction() == MotionEvent.ACTION_MOVE) {
                params.x = Math.max(0, (int) (down[2] - (event.getRawX() - down[0])));
                params.y = Math.max(0, (int) (down[3] + (event.getRawY() - down[1])));
                windowManager.updateViewLayout(panel, params);
                return true;
            }
            if (event.getAction() == MotionEvent.ACTION_UP) {
                if (Math.abs(event.getRawX() - down[0]) < dp(8) && Math.abs(event.getRawY() - down[1]) < dp(8)) {
                    Intent open = new Intent(this, MainActivity.class);
                    open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
                    startActivity(open);
                }
                return true;
            }
            return false;
        });

        overlay = panel;
        windowManager.addView(overlay, params);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @Override public void onDestroy() {
        try { unregisterReceiver(updateReceiver); } catch (Exception ignored) {}
        if (overlay != null && windowManager != null) {
            windowManager.removeView(overlay);
            overlay = null;
        }
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
