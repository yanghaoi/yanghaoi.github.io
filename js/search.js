var searchFunc = function (path, search_id, content_id) {
    'use strict';

    var datas = null;       // 索引数据，第一次真正要用时才下载
    var request = null;     // 进行中的 ajax
    var lastQuery = '';     // 输入框最新内容，索引到位后补渲染

    var $input = document.getElementById(search_id);
    var $resultContent = document.getElementById(content_id);
    if (!$input || !$resultContent) {
        return;
    }

    // 懒加载索引：search.xml 有一百多 KB，不该在首屏就下载。
    // 只在「用户开始输入」或「外部显式预取」时才发请求。
    function loadIndex(callback) {
        if (datas) {
            if (callback) { callback(); }
            return;
        }
        if (!request) {
            request = $.ajax({
                url: path,
                dataType: "xml"
            }).done(function (xmlResponse) {
                // get the contents from search data
                datas = $("entry", xmlResponse).map(function () {
                    var title = $("title", this).text();
                    var content = $("content", this).text();
                    var plain = content.trim().replace(/<[^>]+>/g, "");
                    return {
                        title: title,
                        content: content,
                        url: $("url", this).text(),
                        // 预先算好，避免每敲一个键都对全部正文重做正则和小写转换
                        _title: title.trim().toLowerCase(),
                        _plain: plain,
                        _content: plain.toLowerCase()
                    };
                }).get();
            }).fail(function () {
                request = null;   // 允许下次输入时重试
            });
        }
        request.always(function () {
            if (callback) { callback(); }
        });
    }
    // 暴露给 search.ejs：点击搜索图标时提前把索引拉下来
    window.searchLoadIndex = loadIndex;

    function render(value) {
        var str = '<ul class="search-result-list">';
        var keywords = value.trim().toLowerCase().split(/[\s\-]+/);
        $resultContent.innerHTML = "";
        if (value.trim().length <= 0) {
            return;
        }
        // perform local searching
        datas.forEach(function (data) {
            var isMatch = true;
            var content_index = [];
            var data_title = data._title;
            var data_content = data._content;
            var data_url = data.url;
            var index_title = -1;
            var index_content = -1;
            var first_occur = -1;
            // only match artiles with not empty titles and contents
            if (data_title != '' && data_content != '') {
                keywords.forEach(function (keyword, i) {
                    index_title = data_title.indexOf(keyword);
                    index_content = data_content.indexOf(keyword);
                    if (index_title < 0 && index_content < 0) {
                        isMatch = false;
                    } else {
                        if (index_content < 0) {
                            index_content = 0;
                        }
                        if (i == 0) {
                            first_occur = index_content;
                        }
                    }
                });
            }
            // show search results
            if (isMatch) {
                str += "<li><a href='" + data_url + "' class='search-result-title'>" + data_title + "</a>";
                var content = data._plain;
                if (first_occur >= 0) {
                    // cut out 100 characters
                    var start = first_occur - 20;
                    var end = first_occur + 80;
                    if (start < 0) {
                        start = 0;
                    }
                    if (start == 0) {
                        end = 100;
                    }
                    if (end > content.length) {
                        end = content.length;
                    }
                    var match_content = content.substr(start, end);
                    // highlight all keywords
                    keywords.forEach(function (keyword) {
                        var regS = new RegExp(keyword, "gi");
                        match_content = match_content.replace(regS, "<em class=\"search-keyword\">" + keyword + "</em>");
                    });

                    str += "<p class=\"search-result\">" + match_content + "...</p>"
                }
                str += "</li>";
            }
        });
        str += "</ul>";
        $resultContent.innerHTML = str;
    }

    // 监听立刻绑定：即使索引还没到，用户输入也不会「丢事件」
    $input.addEventListener('input', function () {
        lastQuery = this.value;
        if (lastQuery.trim().length <= 0) {
            $resultContent.innerHTML = "";
            return;
        }
        if (datas) {
            render(lastQuery);
            return;
        }
        $resultContent.innerHTML = '<p class="search-index-loading">正在加载搜索索引…</p>';
        loadIndex(function () {
            if (datas) {
                render(lastQuery);
            } else {
                $resultContent.innerHTML = '<p class="search-index-loading">搜索索引加载失败，请刷新页面后重试。</p>';
            }
        });
    });
}
