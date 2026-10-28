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
 * 学号 / 密码：**Android Keystore 加密**后存进 SharedPreferences。
 *
 * 【为什么不用 localStorage】
 * 网页层（WebView）里的 localStorage 是明文落盘，任何能在这个源里执行的脚本都能读走；
 * 而且它会被 WebView 的备份/调试导出带出去。所以凭证只在**原生**这一侧存在：
 *  - 密钥由系统 Keystore 生成，**不可导出**（应用卸载即失效）；
 *  - 密文 + IV 存 SharedPreferences（MODE_PRIVATE），
 *  - 网页 JS 只能通过窄接口触发「保存 / 清除」，**读不到明文**——
 *    只有自动登录时由原生读出并填入学校自己的登录页。
 *
 * 【两个槽位，不能合并】
 * 教务系统（强智 jsxsd）和云邮教学空间（统一身份认证 CAS）**密码不一样**
 * （2026-10-28 用户实测确认）。早先只有一个槽，改作业密码会把课表导入用的那份覆盖掉，
 * 下次抓课表就会莫名"密码错误"。所以拆成两个独立槽：
 *
 * | 槽 | SharedPreferences | Keystore 别名 |
 * |---|---|---|
 * | 教务 jwgl | `bupt_credentials` | `bupt_cred_key_v1` |
 * | 作业 homework | `bupt_credentials_homework` | `bupt_cred_key_v1_homework` |
 *
 * 教务那一份的存储名**保持不变**，老用户升级后不用重新输密码。
 *
 * 【已知边界】root 过的设备、或厂商备份把密文带走后配合同一台设备的 Keystore，
 * 理论上仍可解密。真正的兜底是：用户可随时一键清除。
 */
final class Credentials {

    private static final String K_DATA = "blob"; // Base64(AES/GCM 密文)
    private static final String K_IV = "iv"; // Base64(IV)
    private static final String K_ACCOUNT = "account"; // 学号（明文，便于展示"已保存 xxx"）
    private static final String K_SAVED_AT = "saved_at";

    /** 教务系统（历史槽位，名字不能改，否则老数据读不到）。 */
    private static final String PREF_JWGL = "bupt_credentials";
    private static final String ALIAS_JWGL = "bupt_cred_key_v1";

    /** 云邮教学空间（作业）。 */
    private static final String PREF_HOMEWORK = "bupt_credentials_homework";
    private static final String ALIAS_HOMEWORK = "bupt_cred_key_v1_homework";

    private Credentials() {}

    /* ------------------------------------------------------------ 教务系统（对外接口保持不变） */

    static boolean has(Context ctx) {
        return has(ctx, PREF_JWGL);
    }

    /** 已保存的学号（明文，仅用于界面展示）；没保存时返回空串。 */
    static String account(Context ctx) {
        return account(ctx, PREF_JWGL);
    }

    static String savedAt(Context ctx) {
        return prefs(ctx, PREF_JWGL).getString(K_SAVED_AT, "");
    }

    static boolean save(Context ctx, String account, String password) {
        return save(ctx, PREF_JWGL, ALIAS_JWGL, account, password);
    }

    static String[] load(Context ctx) {
        return load(ctx, PREF_JWGL, ALIAS_JWGL);
    }

    static void clear(Context ctx) {
        prefs(ctx, PREF_JWGL).edit().clear().apply();
    }

    /* ------------------------------------------------------------ 云邮教学空间（作业） */

    static boolean hasHomework(Context ctx) {
        return has(ctx, PREF_HOMEWORK);
    }

    static String homeworkAccount(Context ctx) {
        return account(ctx, PREF_HOMEWORK);
    }

    static boolean saveHomework(Context ctx, String account, String password) {
        return save(ctx, PREF_HOMEWORK, ALIAS_HOMEWORK, account, password);
    }

    static String[] loadHomework(Context ctx) {
        return load(ctx, PREF_HOMEWORK, ALIAS_HOMEWORK);
    }

    static void clearHomework(Context ctx) {
        prefs(ctx, PREF_HOMEWORK).edit().clear().apply();
    }

    /* ------------------------------------------------------------ 内部实现 */

    private static SharedPreferences prefs(Context ctx, String pref) {
        return ctx.getSharedPreferences(pref, Context.MODE_PRIVATE);
    }

    private static boolean has(Context ctx, String pref) {
        SharedPreferences p = prefs(ctx, pref);
        return p.contains(K_DATA) && p.contains(K_IV) && p.contains(K_ACCOUNT);
    }

    private static String account(Context ctx, String pref) {
        return prefs(ctx, pref).getString(K_ACCOUNT, "");
    }

    /** 保存账号密码（覆盖旧值）。@return true 表示已加密写入 */
    private static boolean save(
            Context ctx, String pref, String alias, String account, String password) {
        String acc = String.valueOf(account == null ? "" : account).trim();
        String pwd = String.valueOf(password == null ? "" : password);
        if (acc.isEmpty() || pwd.isEmpty()) return false;
        try {
            SecretKey key = ensureKey(alias);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key);
            byte[] iv = cipher.getIV();
            byte[] encrypted = cipher.doFinal(pwd.getBytes(Charset.forName("UTF-8")));
            prefs(ctx, pref)
                    .edit()
                    .putString(K_DATA, Base64.encodeToString(encrypted, Base64.NO_WRAP))
                    .putString(K_IV, Base64.encodeToString(iv, Base64.NO_WRAP))
                    .putString(K_ACCOUNT, acc)
                    .putString(K_SAVED_AT, String.valueOf(System.currentTimeMillis()))
                    .apply();
            return true;
        } catch (Exception e) {
            // 加密失败就不要退化成明文保存
            prefs(ctx, pref).edit().clear().apply();
            return false;
        }
    }

    /**
     * 读出账号与密码（只在自动登录时由原生使用）。
     * @return `[account, password]`；没有可用凭证时返回 null
     */
    private static String[] load(Context ctx, String pref, String alias) {
        if (!has(ctx, pref)) return null;
        try {
            SharedPreferences p = prefs(ctx, pref);
            byte[] encrypted = Base64.decode(p.getString(K_DATA, ""), Base64.NO_WRAP);
            byte[] iv = Base64.decode(p.getString(K_IV, ""), Base64.NO_WRAP);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, ensureKey(alias), new GCMParameterSpec(128, iv));
            String password = new String(cipher.doFinal(encrypted), Charset.forName("UTF-8"));
            String account = p.getString(K_ACCOUNT, "");
            if (account.isEmpty() || password.isEmpty()) return null;
            return new String[] {account, password};
        } catch (Exception e) {
            // 密钥被系统清掉（换机/恢复出厂/清数据）→ 视为没有凭证，别让用户卡死
            return null;
        }
    }

    /** 取得（必要时生成）Keystore 里的 AES 密钥；不可导出。 */
    private static SecretKey ensureKey(String alias) throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (!ks.containsAlias(alias)) {
            KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            kg.init(
                    new KeyGenParameterSpec.Builder(
                                    alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                            .setKeySize(256)
                            .build());
            kg.generateKey();
        }
        return (SecretKey) ks.getKey(alias, null);
    }
}
