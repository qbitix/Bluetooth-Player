<?php
require_once __DIR__ . '/env.php';

function GetData () {
    $path = '/tmp/btplayer_state.json';

if (!file_exists($path)) {
    http_response_code(404);
    echo json_encode(['error' => 'Файл состояния не найден']);
    exit;
}

$json = @file_get_contents($path);
if ($json === false || trim($json) === '') {
    http_response_code(500);
    echo json_encode(['error' => 'Не удалось прочитать JSON']);
    exit;
}

$data = json_decode($json, true);
if ($data === null && json_last_error() !== JSON_ERROR_NONE) {
    http_response_code(500);
    echo json_encode(['error' => 'Некорректный JSON: ' . json_last_error_msg()]);
    exit;
}

return $data;
}

function GetArt ($artist, $title) {
    $client_id = env('SPOTIFY_CLIENT_ID', '');
    $client_secret = env('SPOTIFY_CLIENT_SECRET', '');

    if ($client_id === '' || $client_secret === '') {
        error_log('Spotify credentials are not configured');
        return '';
    }

    $ch = curl_init('https://accounts.spotify.com/api/token');
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, 'grant_type=client_credentials');
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        'Authorization: Basic ' . base64_encode($client_id . ':' . $client_secret)
    ]);
    $result = json_decode(curl_exec($ch), true);
    curl_close($ch);

    $token = $result['access_token'];

    $q = urlencode($artist . ' ' . $title);
    $url = "https://api.spotify.com/v1/search?q=$q&type=track&limit=1";
    $ctx = stream_context_create([
        'http' => ['header' => "Authorization: Bearer $token"]
    ]);
    $data = json_decode(file_get_contents($url, false, $ctx), true);
    return $data['tracks']['items'][0]['album']['images'][0]['url'] ?? '';
}

function GetLyric($artist, $title)
{
    $artist = rawurlencode($artist);
    $title  = rawurlencode($title);
    $url = "https://lrclib.net/api/get?artist_name=$artist&track_name=$title";

    $timeout = (int) env('LYRIC_HTTP_TIMEOUT', 5);
    if ($timeout <= 0) {
        $timeout = 5;
    }

    $opts = [
        'http' => [
            'header' => "User-Agent: Mozilla/5.0\r\n",
            'timeout' => $timeout
        ]
    ];
    $context = stream_context_create($opts);

    $json = @file_get_contents($url, false, $context);
    if (!$json) {
        return null;
    }

    $data = json_decode($json, true);
    if (isset($data['syncedLyrics'])) {
        return $data['syncedLyrics'];
    } elseif (isset($data['plainLyrics'])) {
        return $data['plainLyrics'];
    }

    return null;
}
