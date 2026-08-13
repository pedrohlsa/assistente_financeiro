package com.assistfin.app;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.speech.RecognizerIntent;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.List;

/**
 * Ditado por voz no APK.
 *
 * O botão do microfone usava `webkitSpeechRecognition`, que existe no Chrome
 * mas NÃO no Android System WebView — dentro do app a API simplesmente não
 * estava lá, e o microfone não fazia nada.
 *
 * Aqui usamos a tela de ditado do próprio sistema (ACTION_RECOGNIZE_SPEECH) em
 * vez de gravar por conta própria: quem captura o áudio é o app de voz do
 * Android, então o AssistFin não precisa da permissão RECORD_AUDIO nem guarda
 * áudio nenhum. Só recebe o texto final.
 */
@CapacitorPlugin(name = "Speech")
public class SpeechPlugin extends Plugin {

    private Intent recognizerIntent(String prompt) {
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "pt-BR");
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, "pt-BR");
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false);
        if (prompt != null) intent.putExtra(RecognizerIntent.EXTRA_PROMPT, prompt);
        return intent;
    }

    /**
     * Aparelho sem app de ditado instalado existe. Sem esta checagem o app
     * abriria uma tela que não existe e travaria com ActivityNotFoundException.
     */
    @PluginMethod
    public void available(PluginCall call) {
        PackageManager pm = getContext().getPackageManager();
        List<ResolveInfo> matches = pm.queryIntentActivities(recognizerIntent(null), 0);
        JSObject result = new JSObject();
        result.put("available", matches != null && !matches.isEmpty());
        call.resolve(result);
    }

    @PluginMethod
    public void listen(PluginCall call) {
        Intent intent = recognizerIntent(call.getString("prompt", "Fale o que você quer registrar"));
        PackageManager pm = getContext().getPackageManager();
        List<ResolveInfo> matches = pm.queryIntentActivities(intent, 0);
        if (matches == null || matches.isEmpty()) {
            call.reject("no-recognizer");
            return;
        }
        startActivityForResult(call, intent, "speechResult");
    }

    @ActivityCallback
    private void speechResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject ret = new JSObject();
        // Voltar sem falar é cancelamento, não erro: a tela não pode gritar com
        // quem só desistiu de ditar.
        if (result == null || result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            ret.put("cancelled", true);
            ret.put("text", "");
            call.resolve(ret);
            return;
        }
        ArrayList<String> matches = result.getData().getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
        String text = matches != null && !matches.isEmpty() ? matches.get(0) : "";
        ret.put("cancelled", text.isEmpty());
        ret.put("text", text);
        call.resolve(ret);
    }
}
