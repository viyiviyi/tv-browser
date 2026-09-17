package com.dsh.tvbrowser;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

import java.util.List;

/**
 * 收藏 / 最近打开 / 搜索引擎选择的存储。
 *
 * 地址归一化那几条是"同一个网站不要记两条"的关键，
 * 错了的话收藏里会出现一堆看起来一样的条目。
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class SiteStoreTest {

    private SiteStore store;

    @Before
    public void setUp() {
        store = new SiteStore(RuntimeEnvironment.getApplication());
    }

    /* ---------------------------------------------------------- 地址归一 -- */

    @Test
    public void canonicalStripsTrailingSlashOfRootPath() {
        assertEquals("https://www.baidu.com", SiteStore.canonical("https://www.baidu.com/"));
        assertEquals("https://www.baidu.com", SiteStore.canonical("  https://www.baidu.com/  "));
    }

    @Test
    public void canonicalKeepsRealPaths() {
        // 有路径的地址不能被削：/a/ 和 /a 是两个页面
        assertEquals("https://example.com/a/", SiteStore.canonical("https://example.com/a/"));
        assertEquals("https://example.com/a/b", SiteStore.canonical("https://example.com/a/b"));
        assertEquals("https://example.com/?q=1", SiteStore.canonical("https://example.com/?q=1"));
    }

    @Test
    public void canonicalDropsFragment() {
        // #片段只是页内锚点，不该让同一个页面记两条
        assertEquals("https://example.com/doc", SiteStore.canonical("https://example.com/doc#section-3"));
        assertEquals("https://example.com/doc", SiteStore.canonical("https://example.com/doc#"));
    }

    @Test
    public void canonicalHandlesJunk() {
        assertEquals("", SiteStore.canonical(null));
        assertEquals("", SiteStore.canonical("   "));
        assertEquals("", SiteStore.canonical(""));
    }

    @Test
    public void onlyHttpAndHttpsCount() {
        assertTrue(SiteStore.isHttpUrl("http://example.com"));
        assertTrue(SiteStore.isHttpUrl("https://example.com"));
        assertTrue(SiteStore.isHttpUrl("  HTTPS://example.com  "));
        assertFalse(SiteStore.isHttpUrl("file:///android_asset/home.html"));
        assertFalse(SiteStore.isHttpUrl("javascript:alert(1)"));
        assertFalse(SiteStore.isHttpUrl("intent://scan"));
        assertFalse(SiteStore.isHttpUrl(null));
    }

    @Test
    public void hostIsExtractedLowercased() {
        assertEquals("www.bilibili.com", SiteStore.hostOf("https://www.BiliBili.com/video"));
        assertEquals("", SiteStore.hostOf("not a url"));
    }

    /* -------------------------------------------------------------- 收藏 -- */

    @Test
    public void firstRunSeedsDefaultFavorites() {
        List<String> favs = store.favorites();
        assertEquals(SiteStore.DEFAULT_FAVORITES.size(), favs.size());
        assertTrue(favs.contains("https://www.bilibili.com"));
    }

    @Test
    public void addingTheSameSiteTwiceKeepsOne() {
        int before = store.favorites().size();
        assertTrue(store.addFavorite("https://example.com"));
        assertTrue(store.addFavorite("https://example.com/"));
        assertTrue(store.addFavorite("https://example.com#top"));
        assertEquals(before + 1, store.favorites().size());
        assertTrue(store.isFavorite("https://example.com/"));
    }

    @Test
    public void removingAFavoriteWorks() {
        store.addFavorite("https://example.com");
        assertTrue(store.removeFavorite("https://example.com/"));
        assertFalse(store.isFavorite("https://example.com"));
        // 不在里面的再删一次返回 false，不抛异常
        assertFalse(store.removeFavorite("https://example.com"));
    }

    @Test
    public void favoritesStopAtTheLimit() {
        for (int i = 0; i < SiteStore.MAX_FAVORITES + 20; i++) {
            store.addFavorite("https://fill" + i + ".example.com");
        }
        assertEquals(SiteStore.MAX_FAVORITES, store.favorites().size());
        assertFalse("满了之后要如实返回 false，首页好提示用户",
                store.addFavorite("https://one-too-many.example.com"));
    }

    /* ---------------------------------------------------------- 最近打开 -- */

    @Test
    public void recentPutsTheNewestFirst() {
        store.remember("https://a.example.com");
        store.remember("https://b.example.com");
        store.remember("https://c.example.com");
        List<String> recent = store.recent();
        assertEquals("https://c.example.com", recent.get(0));
        assertEquals("https://b.example.com", recent.get(1));
        assertEquals("https://a.example.com", recent.get(2));
    }

    @Test
    public void revisitingMovesTheSiteToTheFrontWithoutDuplicating() {
        store.remember("https://a.example.com");
        store.remember("https://b.example.com");
        store.remember("https://a.example.com/");
        List<String> recent = store.recent();
        assertEquals(2, recent.size());
        assertEquals("https://a.example.com", recent.get(0));
    }

    @Test
    public void forgettingRemovesOnlyThatOne() {
        store.remember("https://a.example.com");
        store.remember("https://b.example.com");
        assertTrue(store.forget("https://a.example.com"));
        assertEquals(1, store.recent().size());
        assertEquals("https://b.example.com", store.recent().get(0));
        assertFalse(store.forget("https://a.example.com"));
    }

    @Test
    public void recentStopsAtTheLimit() {
        for (int i = 0; i < SiteStore.MAX_RECENT + 20; i++) {
            store.remember("https://r" + i + ".example.com");
        }
        assertEquals(SiteStore.MAX_RECENT, store.recent().size());
        assertEquals("https://r" + (SiteStore.MAX_RECENT + 19) + ".example.com", store.recent().get(0));
    }

    /* -------------------------------------------------------- 搜索引擎 -- */

    @Test
    public void engineDefaultsToBaidu() {
        assertEquals(SiteStore.DEFAULT_ENGINE, store.engine());
        assertEquals("baidu", SiteStore.DEFAULT_ENGINE);
    }

    @Test
    public void engineChoiceIsRemembered() {
        store.setEngine("bing");
        assertEquals("bing", store.engine());
        store.setEngine("");
        assertEquals("空字符串不该把选择清掉", "bing", store.engine());
    }

    /* -------------------------------------------------------------- 输出 -- */

    @Test
    public void jsonCarriesEverythingTheHomePageNeeds() throws Exception {
        store.remember("https://a.example.com");
        store.setEngine("sogou");

        // 注意：Android 的 JSONStringer 会把 "//" 转义成 "\/\/"（JSON 允许，也是合法的），
        // 所以这里解析回来比字符串包含，才是首屏真正拿到的样子
        JSONObject o = new JSONObject(store.toJson());
        assertEquals("sogou", o.getString("engine"));
        assertEquals(SiteStore.DEFAULT_FAVORITES.size(), o.getJSONArray("favorites").length());
        JSONArray recent = o.getJSONArray("recent");
        assertEquals(1, recent.length());
        assertEquals("https://a.example.com", recent.getString(0));
    }

    @Test
    public void jsonOfAnEmptyStoreIsStillValid() throws Exception {
        JSONObject o = new JSONObject(store.toJson());
        assertEquals(0, o.getJSONArray("recent").length());
        assertEquals("baidu", o.getString("engine"));
    }
}
