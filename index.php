<?php
require_once __DIR__ . '/env.php';

$appConfig = [
    'pollIntervalMs' => (int) env('PLAYER_POLL_INTERVAL_MS', 1000),
    'lyricOffsetMs' => (int) env('LYRIC_OFFSET_MS', 0),
    'lyricHysteresisMs' => (int) env('LYRIC_HYSTERESIS_MS', 700),
];
?>
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Local Player</title>
    <link rel="stylesheet" href="/style/css/index.css">
    <link rel="stylesheet" href="/style/css/lyrics.css">
    <script src="https://cdn.jsdelivr.net/npm/node-vibrant/dist/vibrant.min.js"></script>
    <script>
        window.appConfig = <?php echo json_encode($appConfig, JSON_UNESCAPED_SLASHES); ?>;
    </script>
</head>

<body>
    <div class="content">
        <div class="musicConts">
            <img id="cover"
                 src="https://imgs.search.brave.com/UlCcvSmylueR4-XxRUaXiMq6aohudhJSz1J8Aq7DEFo/rs:fit:860:0:0:0/g:ce/aHR0cHM6Ly9jZG4t/aWNvbnMtcG5nLmZy/ZWVwaWsuY29tLzI1/Ni8xNDc3Ni8xNDc3/Njg4OS5wbmc_c2Vt/dD1haXNfd2hpdGVf/bGFiZWw"
                 alt="Cover"
                 crossorigin="anonymous"
                 referrerpolicy="no-referrer">

            <div class="info">
                <h2 id="title" class="title">Title</h2>
                <h4 id="artist" class="artist">artist</h4>
            </div>

            <div class="bar"><div class="fill" id="fill"></div></div>
            <div class="time">
                <span id="cur">0:00</span>
                <span id="dur">3:12</span>
            </div>
        </div>
        <div id="lyric" class="lyric">
            
        </div>
    </div>
    <script src="/js/start.js"></script>
    <script src="/js/background.js"></script>
    <script src="/js/lyrics.js"></script>
</body>
</html>
