package com.bupt.schedule;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.Charset;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * 教务系统的学号 / 密码：**Android Keystore 加密**后存进 SharedPreferences。
 *
 * 【为什么不用 localStorage】
 * 网页层（WebView）里的 localStorage 是明文落盘，任何能在这个源里执行的脚本都能读走；
 * 而且它会被 WebView 的备份/调试导出带出去。所以凭证只在**原生**这一侧存在：
 *  - 密钥由系统 Keystore 生成，**不可导出**（应用卸载即失效）；
 *  - 密文 + IV 存 SharedPreferences（MODE_PRIVATE），
 *  - 网页 JS 只能通过两个窄接口触发「保存 / 清除」，**读不到明文**——
 *    只有自动登录时由原生读出并填入学校自己的登录页。
 *
 * 【已知边界】root 过的设备、或厂商备份把密文带走后配合同一台设备的 Keystore，
 * 理论上仍可解密。真正的兜底是：用户可随时在「更新课表」卡片里一键清除。
 */
final class Credentials {

    private static final String PREF = "bupt_credentials";
    private static final String KEY_ALIAS = "bupt_cred_key_v1";
    private static final String K_DATA = "blob";     // Base64(AES/GCM 密文)
    private static final String K_IV = "iv";         // Base64(IV)
    private static final String K_ACCOUNT = "account"; // 学号（明文，便于展示"已保存 xxx"）
    private static final String K_SAVED_AT = "saved_at";

    private Credentials() {}

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE);
    }

    static boolean has(Context ctx) {
        SharedPreferences p = prefs(ctx);
        return p.contains(K_DATA) && p.contains(K_IV) && p.contains(K_ACCOUNT);
    }

    /** 已保存的学号（明文，仅用于界面展示）；没保存时返回空串。 */
    static String account(Context ctx) {
        return prefs(ctx).getString(K_ACCOUNT, "");
    }

    static String savedAt(Context ctx) {
        return prefs(ctx).getString(K_SAVED_AT, "");
    }

    /**
     * 保存账号密码（覆盖旧值）。
     * @return true 表示已加密写入
     */
    static boolean save(Context ctx, String account, String password) {
        String acc = String.valueOf(account == null ? "" : account).trim();
        String pwd = String.valueOf(password == null ? "" : password);
        if (acc.isEmpty() || pwd.isEmpty()) return false;
        try {
            SecretKey key = ensureKey();
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key);
            byte[] iv = cipher.getIV();
            byte[] encrypted = cipher.doFinal(pwd.getBytes(Charset.forName("UTF-8")));
            prefs(ctx)
                    .edit()
                    .putString(K_DATA, Base64.encodeToString(encrypted, Base64.NO_WRAP))
                    .putString(K_IV, Base64.encodeToString(iv, Base64.NO_WRAP))
                    .putString(K_ACCOUNT, acc)
                    .putString(K_SAVED_AT, String.valueOf(System.currentTimeMillis()))
                    .apply();
            return true;
        } catch (Exception e) {
            // 加密失败就不要退化成明文保存
            clear(ctx);
            return false;
        }
    }

    /**
     * 读出账号与密码（只在自动登录时由原生使用）。
     * @return `[account, password]`；没有可用凭证时返回 null
     */
    static String[] load(Context ctx) {
        if (!has(ctx)) return null;
        try {
            SharedPreferences p = prefs(ctx);
            byte[] encrypted = Base64.decode(p.getString(K_DATA, ""), Base64.NO_WRAP);
            byte[] iv = Base64.decode(p.getString(K_IV, ""), Base64.NO_WRAP);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, ensureKey(), new GCMParameterSpec(128, iv));
            String password = new String(cipher.doFinal(encrypted), Charset.forName("UTF-8"));
            String account = p.getString(K_ACCOUNT, "");
            if (account.isEmpty() || password.isEmpty()) return null;
            return new String[] {account, password};
        } catch (Exception e) {
            // 密钥被系统清掉（换机/恢复出厂/清数据）→ 视为没有凭证，别让用户卡死
            return null;
        }
    }

    static void clear(Context ctx) {
        prefs(ctx).edit().clear().apply();
    }

    /** 取得（必要时生成）Keystore 里的 AES 密钥；不可导出。 */
    private static SecretKey ensureKey() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (!ks.containsAlias(KEY_ALIAS)) {
            KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            kg.init(
                    new KeyGenParameterSpec.Builder(
                                    KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                            .setKeySize(256)
                            .build());
            kg.generateKey();
        }
        return (SecretKey) ks.getKey(KEY_ALIAS, null);
    }
}
