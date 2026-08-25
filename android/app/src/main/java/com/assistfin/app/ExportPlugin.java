package com.assistfin.app;

import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Exportar backup e planilhas de dentro do APK.
 *
 * A tela criava um Blob e clicava num `<a download>`. Isso funciona no
 * navegador, mas o WebView do Capacitor NÃO tem DownloadListener: o clique
 * simplesmente não fazia nada e o arquivo nunca existia. Era esse o "problema
 * pra exportar o JSON".
 *
 * Aqui o arquivo é escrito de verdade. Em Android 10+ vai para a pasta
 * Downloads pelo MediaStore, sem pedir permissão de armazenamento; abaixo
 * disso, para a pasta do próprio app (também sem permissão). Depois o usuário
 * pode mandar o arquivo para onde quiser pelo menu de compartilhar.
 */
@CapacitorPlugin(name = "Export")
public class ExportPlugin extends Plugin {

    private File legacyFile(String filename) throws Exception {
        File dir = getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (dir == null) dir = getContext().getFilesDir();
        if (!dir.exists() && !dir.mkdirs()) throw new Exception("sem-pasta");
        return new File(dir, filename);
    }

    @PluginMethod
    public void save(PluginCall call) {
        String filename = call.getString("filename");
        String mime = call.getString("mime", "application/octet-stream");
        String data = call.getString("data", "");
        if (filename == null || filename.isEmpty()) {
            call.reject("sem-nome");
            return;
        }

        try {
            byte[] bytes = data.getBytes(StandardCharsets.UTF_8);
            String where;

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, filename);
                values.put(MediaStore.Downloads.MIME_TYPE, mime);
                values.put(MediaStore.Downloads.IS_PENDING, 1);
                Uri uri = getContext().getContentResolver()
                    .insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) throw new Exception("sem-uri");
                try (OutputStream out = getContext().getContentResolver().openOutputStream(uri)) {
                    if (out == null) throw new Exception("sem-stream");
                    out.write(bytes);
                }
                // Só depois de escrito o arquivo aparece para os outros apps —
                // sem isto, um gerenciador de arquivos veria um item vazio.
                values.clear();
                values.put(MediaStore.Downloads.IS_PENDING, 0);
                getContext().getContentResolver().update(uri, values, null, null);
                where = "Downloads";
            } else {
                File file = legacyFile(filename);
                try (FileOutputStream out = new FileOutputStream(file)) {
                    out.write(bytes);
                }
                where = file.getParentFile() != null ? file.getParentFile().getName() : "Arquivos";
            }

            JSObject result = new JSObject();
            result.put("saved", true);
            result.put("filename", filename);
            result.put("where", where);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("falha-ao-salvar", e);
        }
    }

    /** Menu de compartilhar, para mandar o backup para outro aparelho ou nuvem. */
    @PluginMethod
    public void share(PluginCall call) {
        String filename = call.getString("filename");
        String mime = call.getString("mime", "application/octet-stream");
        String data = call.getString("data", "");
        if (filename == null || filename.isEmpty()) {
            call.reject("sem-nome");
            return;
        }

        try {
            Context context = getContext();
            // Cache: o arquivo compartilhado é uma cópia descartável, o
            // original já foi salvo em Downloads por `save`.
            File dir = new File(context.getCacheDir(), "export");
            if (!dir.exists() && !dir.mkdirs()) throw new Exception("sem-pasta");
            File file = new File(dir, filename);
            try (FileOutputStream out = new FileOutputStream(file)) {
                out.write(data.getBytes(StandardCharsets.UTF_8));
            }

            Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", file);
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType(mime);
            send.putExtra(Intent.EXTRA_STREAM, uri);
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

            Intent chooser = Intent.createChooser(send, "Enviar " + filename);
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(chooser);

            JSObject result = new JSObject();
            result.put("shared", true);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("falha-ao-compartilhar", e);
        }
    }
}
