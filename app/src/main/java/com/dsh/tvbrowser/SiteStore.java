package com.dsh.tvbrowser;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * 收藏 / 最近打开 / 搜索引擎选择的存储。
 *
 * 只存 URL：名称、颜色、图标都由首屏自己按域名推（见 assets/home.js）——
 * 名字要中文的、图标要站点自己的 favicon，这些是"显示"的事，
 * 放在原生这边只会变成一堆要和首页同步的字面量。
 *
 * 纯逻辑的那几个方法（canonical / isHttpUrl）是静态的，方便单测。
 */
public final class SiteStore {

    /** 收藏上限：超过之后首页长按收藏会提示"收藏已满" */
    public static final int MAX_FAVORITES = 60;
    /** 最近打开上限：首页只显示一排，多存一些是为了"删掉还能回来" */
    public static final int MAX_RECENT = 60;

    public static final String DEFAULT_ENGINE = "baidu";

    private static final String PREF = "tv_browser";
    private static final String KEY_FAVORITES = "favorites";
    private static final String KEY_RECENT = "recent";
    private static final String KEY_ENGINE = "engine";
    private static final String KEY_SEEDED = "seeded";

    /**
     * 第一次运行时预置的收藏。
     * 中文名和品牌色在 assets/home.js 的 NAMES / TINTS 里按域名匹配。
     */
    public static final List<String> DEFAULT_FAVORITES = Arrays.asList(
            "https://www.bilibili.com",
            "https://www.baidu.com",
            "https://weibo.com",
            "https://www.zhihu.com",
            "https://www.taobao.com",
            "https://www.jd.com",
            "https://v.qq.com",
            "https://www.iqiyi.com",
            "https://www.youku.com",
            "https://www.douban.com",
            "https://music.163.com",
            "https://tv.cctv.com"
    );

    private final SharedPreferences prefs;

    public SiteStore(Context context) {
        this(context.getApplicationContext().getSharedPreferences(PREF, Context.MODE_PRIVATE));
    }

    /** 单元测试直接塞一个假了的 SharedPreferences 进来 */
    SiteStore(SharedPreferences prefs) {
        this.prefs = prefs;
        seedIfNeeded();
    }

    /* ---------------------------------------------------------- 纯逻辑 -- */

    /**
     * URL 归一化：去掉首尾空白和 #片段、去掉根路径结尾的斜杠。
     * 用于"同一个网站不要记两条"。
     */
    public static String canonical(String url) {
        if (url == null) return "";
        String s = url.trim();
        if (s.isEmpty()) return "";
        int frag = s.indexOf('#');
        if (frag >= 0) s = s.substring(0, frag).trim();
        int scheme = s.indexOf("://");
        if (scheme >= 0 && s.endsWith("/")) {
            String rest = s.substring(scheme + 3);
            // 只有一个结尾斜杠（根路径）才去掉；/a/ 这种保留
            if (rest.indexOf('/') == rest.length() - 1) s = s.substring(0, s.length() - 1);
        }
        return s;
    }

    public static boolean isHttpUrl(String url) {
        if (url == null) return false;
        String s = url.trim().toLowerCase();
        return s.startsWith("http://") || s.startsWith("https://");
    }

    /** 从 URL 里取主机名，取不到返回 "" */
    public static String hostOf(String url) {
        try {
            String h = Uri.parse(url).getHost();
            return h == null ? "" : h.toLowerCase();
        } catch (Throwable t) {
            return "";
        }
    }

    /* ------------------------------------------------------------ 收藏 -- */

    public List<String> favorites() {
        return readList(KEY_FAVORITES);
    }

    public boolean isFavorite(String url) {
        String u = canonical(url);
        return !u.isEmpty() && favorites().contains(u);
    }

    /**
     * 加收藏。
     * @return false 只有一种情况：收藏满了
     */
    public boolean addFavorite(String url) {
        String u = canonical(url);
        if (u.isEmpty()) return false;
        List<String> list = favorites();
        if (list.contains(u)) return true;
        if (list.size() >= MAX_FAVORITES) return false;
        list.add(u);
        writeList(KEY_FAVORITES, list);
        return true;
    }

    public boolean removeFavorite(String url) {
        String u = canonical(url);
        List<String> list = favorites();
        if (u.isEmpty() || !list.remove(u)) return false;
        writeList(KEY_FAVORITES, list);
        return true;
    }

    /* -------------------------------------------------------- 最近打开 -- */

    /** 记一条浏览记录：已经在里面的提到最前面，超出上限的丢掉最老的 */
    public List<String> recent() {
        return readList(KEY_RECENT);
    }

    public void remember(String url) {
        String u = canonical(url);
        if (u.isEmpty()) return;
        List<String> list = recent();
        list.remove(u);
        list.add(0, u);
        while (list.size() > MAX_RECENT) list.remove(list.size() - 1);
        writeList(KEY_RECENT, list);
    }

    public boolean forget(String url) {
        String u = canonical(url);
        List<String> list = recent();
        if (u.isEmpty() || !list.remove(u)) return false;
        writeList(KEY_RECENT, list);
        return true;
    }

    /** 收藏和最近打开里都不要再出现这个网站（测试和重置用） */
    public void forgetEverywhere(String url) {
        removeFavorite(url);
        forget(url);
    }

    /* ------------------------------------------------------ 搜索引擎 -- */

    public String engine() {
        String id = prefs.getString(KEY_ENGINE, DEFAULT_ENGINE);
        return id == null || id.isEmpty() ? DEFAULT_ENGINE : id;
    }

    public void setEngine(String id) {
        if (id == null || id.isEmpty()) return;
        prefs.edit().putString(KEY_ENGINE, id).apply();
    }

    /* ------------------------------------------------------------ 输出 -- */

    /** 推给首页的那份数据 */
    public String toJson() {
        try {
            JSONObject o = new JSONObject();
            o.put("favorites", new JSONArray(favorites()));
            o.put("recent", new JSONArray(recent()));
            o.put("engine", engine());
            return o.toString();
        } catch (JSONException e) {
            return "{\"favorites\":[],\"recent\":[],\"engine\":\"" + DEFAULT_ENGINE + "\"}";
        }
    }

    /* ------------------------------------------------------------ 内部 -- */

    private void seedIfNeeded() {
        if (prefs.getBoolean(KEY_SEEDED, false)) return;
        List<String> seed = new ArrayList<>();
        for (String url : DEFAULT_FAVORITES) {
            String u = canonical(url);
            if (!u.isEmpty() && !seed.contains(u) && seed.size() < MAX_FAVORITES) seed.add(u);
        }
        prefs.edit()
                .putString(KEY_FAVORITES, new JSONArray(seed).toString())
                .putBoolean(KEY_SEEDED, true)
                .apply();
    }

    private List<String> readList(String key) {
        List<String> out = new ArrayList<>();
        String raw = prefs.getString(key, null);
        if (raw == null || raw.isEmpty()) return out;
        try {
            JSONArray arr = new JSONArray(raw);
            for (int i = 0; i < arr.length(); i++) {
                String v = arr.optString(i, "");
                if (v != null && !v.isEmpty()) out.add(v);
            }
        } catch (JSONException ignored) {
            // 存坏了就当空列表，不要让首页挂掉
        }
        return out;
    }

    private void writeList(String key, List<String> list) {
        prefs.edit().putString(key, new JSONArray(list).toString()).apply();
    }
}
