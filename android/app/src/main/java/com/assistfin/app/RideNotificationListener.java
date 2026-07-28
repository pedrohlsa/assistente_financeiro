package com.assistfin.app;

import android.app.Notification;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

import java.text.NumberFormat;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class RideNotificationListener extends NotificationListenerService {
    private static final Pattern MONEY = Pattern.compile("R\\$\\s*([\\d.]+(?:,\\d{1,2})?)", Pattern.CASE_INSENSITIVE);
    private static final Pattern KM = Pattern.compile("([\\d.,]+)\\s*km\\b", Pattern.CASE_INSENSITIVE);

    @Override public void onNotificationPosted(StatusBarNotification sbn) {
        SharedPreferences prefs = getSharedPreferences(RideOverlayService.PREFS, MODE_PRIVATE);
        if (!prefs.getBoolean("enabled", false)) return;

        Bundle extras = sbn.getNotification().extras;
        String text = collect(extras);
        String pkg = sbn.getPackageName().toLowerCase(Locale.ROOT);
        String lower = text.toLowerCase(Locale.ROOT);
        boolean rideApp = pkg.contains("uber") || pkg.contains("taxis99") || pkg.contains("indriver");
        boolean rideText = lower.contains("uber") || lower.contains("inDrive".toLowerCase(Locale.ROOT))
            || lower.contains("nova corrida") || lower.contains("oferta de corrida") || lower.contains("99 motorista");
        if (!rideApp && !rideText) return;

        String analysis = analyze(text, prefs.getFloat("costPerKm", 0f), prefs.getFloat("minPerKm", 0f));
        Intent update = new Intent(RideOverlayService.ACTION_UPDATE);
        update.setPackage(getPackageName());
        update.putExtra("text", analysis);
        sendBroadcast(update);
    }

    private String collect(Bundle extras) {
        List<String> parts = new ArrayList<>();
        add(parts, extras.getCharSequence(Notification.EXTRA_TITLE));
        add(parts, extras.getCharSequence(Notification.EXTRA_TEXT));
        add(parts, extras.getCharSequence(Notification.EXTRA_BIG_TEXT));
        CharSequence[] lines = extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES);
        if (lines != null) for (CharSequence line : lines) add(parts, line);
        return String.join(" · ", parts);
    }

    private void add(List<String> parts, CharSequence value) {
        if (value == null) return;
        String text = value.toString().trim();
        if (!text.isEmpty() && !parts.contains(text)) parts.add(text);
    }

    private double number(String raw) {
        String clean = raw.replace(".", "").replace(",", ".");
        try { return Double.parseDouble(clean); } catch (Exception ignored) { return 0; }
    }

    private String analyze(String source, float costPerKm, float minPerKm) {
        Matcher money = MONEY.matcher(source);
        Matcher kms = KM.matcher(source);
        double amount = money.find() ? number(money.group(1)) : 0;
        double totalKm = 0;
        while (kms.find()) totalKm += number(kms.group(1));

        if (amount > 0 && totalKm > 0) {
            double gross = amount / totalKm;
            double net = gross - costPerKm;
            String verdict = minPerKm > 0 ? (gross >= minPerKm ? "acima do seu mínimo" : "abaixo do seu mínimo") : "estimativa";
            return money(amount) + " · " + one(totalKm) + " km\n"
                + money(gross) + "/km bruto · " + money(net) + "/km após custos\n"
                + verdict;
        }
        String compact = source.replaceAll("\\s+", " ").trim();
        if (compact.length() > 150) compact = compact.substring(0, 147) + "…";
        return compact.isEmpty() ? "Oferta recebida. Toque para analisar manualmente." : compact;
    }

    private String money(double value) {
        return NumberFormat.getCurrencyInstance(new Locale("pt", "BR")).format(value);
    }

    private String one(double value) {
        return String.format(new Locale("pt", "BR"), "%.1f", value);
    }
}
