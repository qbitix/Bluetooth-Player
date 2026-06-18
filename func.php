<?php
require_once __DIR__ . '/env.php';

function GetData() {
    $path = (string) env('PLAYER_STATE_FILE', 'runtime/btplayer_state.json');
    if ($path === '') {
        $path = 'runtime/btplayer_state.json';
    }

    if (!str_starts_with($path, '/')) {
        $path = __DIR__ . '/' . $path;
    }

    if (!file_exists($path)) {
        http_response_code(404);
        echo json_encode(['error' => 'State file not found']);
        exit;
    }

    $json = @file_get_contents($path);
    if ($json === false || trim($json) === '') {
        http_response_code(500);
        echo json_encode(['error' => 'Could not read JSON']);
        exit;
    }

    $data = json_decode($json, true);
    if ($data === null && json_last_error() !== JSON_ERROR_NONE) {
        http_response_code(500);
        echo json_encode(['error' => 'Invalid JSON: ' . json_last_error_msg()]);
        exit;
    }

    return $data;
}

function ArtworkHttpTimeout(): int {
    $timeout = (int) env('ART_HTTP_TIMEOUT', 5);
    return $timeout > 0 ? $timeout : 5;
}

function ArtworkUserAgent(): string {
    return 'Mozilla/5.0 (X11; CrOS x86_64 16610.44.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.7727.115 Safari/537.36';
}

function IsSearchableMetadata(string $artist, string $title): bool {
    $unknownValues = ['', 'unknown', 'unknown artist', 'unknown title'];
    return !in_array(strtolower(trim($artist)), $unknownValues, true)
        && !in_array(strtolower(trim($title)), $unknownValues, true);
}

function FetchJson(string $url, int $timeout): ?array {
    $ch = curl_init($url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_TIMEOUT, $timeout);
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        'Accept: application/json',
        'User-Agent: ' . ArtworkUserAgent()
    ]);
    $response = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlError = curl_error($ch);
    curl_close($ch);

    if ($response === false || $status < 200 || $status >= 300) {
        error_log('JSON request failed: HTTP ' . $status . ' ' . $url . ($curlError !== '' ? ' - ' . $curlError : ''));
        return null;
    }

    $data = json_decode($response, true);
    return is_array($data) ? $data : null;
}

function FetchHttpBatch(array $requests, int $timeout): array {
    if (!$requests) {
        return [];
    }

    $multi = curl_multi_init();
    $handles = [];

    foreach ($requests as $index => $request) {
        $url = $request['url'] ?? '';
        if ($url === '') {
            continue;
        }

        $accept = $request['accept'] ?? 'application/json';
        $ch = curl_init($url);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_TIMEOUT, $timeout);
        curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
        curl_setopt($ch, CURLOPT_HTTPHEADER, [
            'Accept: ' . $accept,
            'User-Agent: ' . ArtworkUserAgent()
        ]);

        curl_multi_add_handle($multi, $ch);
        $handles[$index] = $ch;
    }

    do {
        $status = curl_multi_exec($multi, $running);
        if ($running) {
            curl_multi_select($multi, 0.5);
        }
    } while ($running && $status === CURLM_OK);

    $responses = [];
    foreach ($handles as $index => $ch) {
        $body = curl_multi_getcontent($ch);
        $httpStatus = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $curlError = curl_error($ch);
        curl_multi_remove_handle($multi, $ch);
        curl_close($ch);

        $responses[$index] = [
            'body' => is_string($body) ? $body : '',
            'status' => $httpStatus,
            'error' => $curlError,
            'meta' => $requests[$index]['meta'] ?? [],
            'url' => $requests[$index]['url'] ?? '',
        ];
    }

    curl_multi_close($multi);
    ksort($responses);
    return $responses;
}

function FetchJsonBatch(array $requests, int $timeout): array {
    $responses = FetchHttpBatch($requests, $timeout);

    foreach ($responses as $index => $response) {
        if ($response['status'] < 200 || $response['status'] >= 300 || $response['body'] === '') {
            $responses[$index]['data'] = null;
            if (($response['status'] ?? 0) !== 404) {
                error_log('JSON batch request failed: HTTP ' . $response['status'] . ' ' . $response['url'] . (($response['error'] ?? '') !== '' ? ' - ' . $response['error'] : ''));
            }
            continue;
        }

        $data = json_decode($response['body'], true);
        $responses[$index]['data'] = is_array($data) ? $data : null;
    }

    return $responses;
}

function LogHttpBody(string $message, mixed $body): void {
    $text = is_string($body) ? $body : '';

    if ($text === '') {
        error_log($message . ': <empty>');
        return;
    }

    $decoded = json_decode($text, true);
    if (is_array($decoded)) {
        foreach (['access_token', 'refresh_token', 'client_secret'] as $key) {
            if (array_key_exists($key, $decoded)) {
                $decoded[$key] = '[redacted]';
            }
        }

        $text = json_encode($decoded, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    }

    if (strlen($text) > 2000) {
        $text = substr($text, 0, 2000) . '...<truncated>';
    }

    error_log($message . ': ' . $text);
}

function FindItunesArtwork(string $term, int $timeout): string {
    $query = http_build_query([
        'term' => $term,
        'media' => 'music',
        'entity' => 'song',
        'limit' => 1
    ]);

    $data = FetchJson('https://itunes.apple.com/search?' . $query, $timeout);
    $artwork = $data['results'][0]['artworkUrl100'] ?? '';

    if ($artwork === '') {
        return '';
    }

    return preg_replace('/\/\d+x\d+bb\.(jpg|png)$/', '/600x600bb.$1', $artwork) ?? $artwork;
}

function SpotifySearchQuery(string $artist, string $title): string {
    $parts = [];
    $title = trim($title);
    $artist = trim($artist);

    if ($title !== '') {
        $parts[] = 'track:' . $title;
    }

    if ($artist !== '') {
        $artistParts = preg_split('/\s*(?:,|&|\band\b|\bfeat\.?\b|\bft\.?\b|\/|\+)\s*/i', $artist, -1, PREG_SPLIT_NO_EMPTY);

        if (!$artistParts) {
            $artistParts = [$artist];
        }

        foreach ($artistParts as $artistPart) {
            $artistPart = trim($artistPart);
            if ($artistPart !== '') {
                $parts[] = 'artist:' . $artistPart;
            }
        }
    }

    return implode(' ', $parts);
}

function FindSpotifyArtwork(string $artist, string $title, int $timeout): string {
    $clientId = env('SPOTIFY_CLIENT_ID', '');
    $clientSecret = env('SPOTIFY_CLIENT_SECRET', '');

    if ($clientId === '' || $clientSecret === '') {
        error_log('Spotify artwork fallback skipped: credentials are not configured');
        return '';
    }

    $ch = curl_init('https://accounts.spotify.com/api/token');
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, 'grant_type=client_credentials');
    curl_setopt($ch, CURLOPT_TIMEOUT, $timeout);
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        'Authorization: Basic ' . base64_encode($clientId . ':' . $clientSecret),
        'Content-Type: application/x-www-form-urlencoded',
        'User-Agent: ' . ArtworkUserAgent()
    ]);
    $response = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlError = curl_error($ch);
    curl_close($ch);

    if ($response === false || $status < 200 || $status >= 300) {
        error_log('Spotify token request failed: HTTP ' . $status . ($curlError !== '' ? ' - ' . $curlError : ''));
        LogHttpBody('Spotify token response body', $response);
        return '';
    }

    $data = json_decode($response, true);
    $token = is_array($data) ? ($data['access_token'] ?? '') : '';

    if ($token === '') {
        error_log('Spotify token response did not contain an access token');
        return '';
    }

    $spotifyQuery = SpotifySearchQuery($artist, $title);
    if ($spotifyQuery === '') {
        return '';
    }

    $query = http_build_query([
        'q' => $spotifyQuery,
        'type' => 'track',
        'limit' => 1,
        'market' => 'US'
    ]);
    $ch = curl_init('https://api.spotify.com/v1/search?' . $query);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_TIMEOUT, $timeout);
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        'Authorization: Bearer ' . $token,
        'User-Agent: ' . ArtworkUserAgent()
    ]);
    $response = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlError = curl_error($ch);
    curl_close($ch);

    if ($response === false || $status < 200 || $status >= 300) {
        error_log('Spotify artwork fallback failed: HTTP ' . $status . ($curlError !== '' ? ' - ' . $curlError : ''));
        LogHttpBody('Spotify search response body', $response);
        return '';
    }

    $data = json_decode($response, true);
    return is_array($data) ? ($data['tracks']['items'][0]['album']['images'][0]['url'] ?? '') : '';
}

function MusicBrainzQuote(string $value): string {
    return '"' . str_replace(['\\', '"'], ['\\\\', '\\"'], $value) . '"';
}

function FindCoverArtArchiveImage(string $mbid, string $type, int $timeout): string {
    $url = "https://coverartarchive.org/$type/$mbid/front-500";
    $ch = curl_init($url);
    curl_setopt($ch, CURLOPT_NOBODY, true);
    curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_TIMEOUT, $timeout);
    curl_setopt($ch, CURLOPT_HTTPHEADER, ['User-Agent: ' . ArtworkUserAgent()]);
    curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $effectiveUrl = curl_getinfo($ch, CURLINFO_EFFECTIVE_URL) ?: $url;
    $curlError = curl_error($ch);
    curl_close($ch);

    if ($status >= 200 && $status < 300) {
        return $effectiveUrl;
    }

    if ($status !== 404) {
        error_log('Cover Art Archive request failed: HTTP ' . $status . ' ' . $url . ($curlError !== '' ? ' - ' . $curlError : ''));
    }

    return '';
}

function FindMusicBrainzArtwork(string $artist, string $title, int $timeout): string {
    $query = 'artist:' . MusicBrainzQuote($artist) . ' AND recording:' . MusicBrainzQuote($title);
    $url = 'https://musicbrainz.org/ws/2/recording/?' . http_build_query([
        'query' => $query,
        'fmt' => 'json',
        'limit' => 5,
        'inc' => 'releases+release-groups'
    ]);

    $data = FetchJson($url, $timeout);
    $recordings = $data['recordings'] ?? [];

    if (!is_array($recordings)) {
        return '';
    }

    foreach ($recordings as $recording) {
        foreach (($recording['releases'] ?? []) as $release) {
            $releaseId = $release['id'] ?? '';
            if ($releaseId === '') {
                continue;
            }

            $artwork = FindCoverArtArchiveImage($releaseId, 'release', $timeout);
            if ($artwork !== '') {
                return $artwork;
            }
        }

        $releaseGroupId = $recording['release-group']['id'] ?? '';
        if ($releaseGroupId !== '') {
            $artwork = FindCoverArtArchiveImage($releaseGroupId, 'release-group', $timeout);
            if ($artwork !== '') {
                return $artwork;
            }
        }
    }

    return '';
}

function LogArtworkProvider(string $provider, string $status, string $artist, string $title, string $details = ''): void {
    $message = '[Artwork] ' . $provider . ' ' . $status . ': ' . $artist . ' - ' . $title;
    if ($details !== '') {
        $message .= ' | ' . $details;
    }

    error_log($message);
}

function GetArt($artist, $title) {
    if (!IsSearchableMetadata((string) $artist, (string) $title)) {
        error_log('[Artwork] skipped: unknown metadata ' . $artist . ' - ' . $title);
        return '';
    }

    $term = trim($artist . ' ' . $title);

    if ($term === '') {
        error_log('[Artwork] skipped: empty artist/title');
        return '';
    }

    $timeout = ArtworkHttpTimeout();

    LogArtworkProvider('iTunes', 'request', $artist, $title, 'term="' . $term . '"');
    $artwork = FindItunesArtwork($term, $timeout);

    if ($artwork !== '') {
        LogArtworkProvider('iTunes', 'found', $artist, $title, $artwork);
        return $artwork;
    }

    LogArtworkProvider('iTunes', 'not_found', $artist, $title);
    LogArtworkProvider('Spotify', 'request', $artist, $title);
    $artwork = FindSpotifyArtwork($artist, $title, $timeout);

    if ($artwork !== '') {
        LogArtworkProvider('Spotify', 'found', $artist, $title, $artwork);
        return $artwork;
    }

    LogArtworkProvider('Spotify', 'not_found', $artist, $title);
    LogArtworkProvider('MusicBrainz/CoverArtArchive', 'request', $artist, $title);
    $artwork = FindMusicBrainzArtwork($artist, $title, $timeout);

    if ($artwork === '') {
        LogArtworkProvider('MusicBrainz/CoverArtArchive', 'not_found', $artist, $title);
        error_log('[Artwork] all providers failed: ' . $artist . ' - ' . $title);
    } else {
        LogArtworkProvider('MusicBrainz/CoverArtArchive', 'found', $artist, $title, $artwork);
    }

    return $artwork;
}

function LyricHttpTimeout(): int {
    $timeout = (int) env('LYRIC_HTTP_TIMEOUT', 5);
    if ($timeout <= 0) {
        $timeout = 5;
    }

    return $timeout;
}

function LyricProviders(): array {
    $configured = trim((string) env('LYRIC_PROVIDERS', 'lrclib_synced,lrclib_search_synced,lrclib,lrclib_search,lyrics_ovh,chartlyrics'));
    if ($configured === '') {
        return [];
    }

    return array_values(array_filter(array_map(
        static fn ($provider) => strtolower(trim($provider)),
        explode(',', $configured)
    )));
}

function NormalizeLyricText(?string $lyrics): ?string {
    if ($lyrics === null) {
        return null;
    }

    $lyrics = trim(str_replace(["\r\n", "\r"], "\n", $lyrics));
    return $lyrics === '' ? null : $lyrics;
}

function NormalizeLyricTitle(string $title): string {
    $title = preg_replace('/\s*[\(\[]\s*(?:feat\.?|ft\.?|with|prod\.?|remaster(?:ed)?|radio edit|explicit|clean|official audio|official video).*?[\)\]]\s*/iu', ' ', $title) ?? $title;
    $title = preg_replace('/\s+-\s+(?:remaster(?:ed)?|radio edit|explicit|clean|official audio|official video).*$/iu', '', $title) ?? $title;
    $title = preg_replace('/\s+/', ' ', $title) ?? $title;
    return trim($title);
}

function LyricCandidatePairs(string $artist, string $title): array {
    $pairs = [];
    $normalizedTitle = NormalizeLyricTitle($title);
    $artistParts = preg_split('/\s*(?:,|&|\band\b|\bfeat\.?\b|\bft\.?\b|\/|\+)\s*/iu', $artist, -1, PREG_SPLIT_NO_EMPTY);

    $addPair = static function (string $nextArtist, string $nextTitle) use (&$pairs): void {
        $nextArtist = trim($nextArtist);
        $nextTitle = trim($nextTitle);
        if ($nextArtist === '' || $nextTitle === '') {
            return;
        }

        $key = mb_strtolower($nextArtist . '::' . $nextTitle);
        $pairs[$key] = ['artist' => $nextArtist, 'title' => $nextTitle];
    };

    $addPair($artist, $title);
    if ($normalizedTitle !== '' && $normalizedTitle !== $title) {
        $addPair($artist, $normalizedTitle);
    }

    if (is_array($artistParts) && count($artistParts) > 0) {
        $primaryArtist = trim($artistParts[0]);
        $addPair($primaryArtist, $title);
        if ($normalizedTitle !== '' && $normalizedTitle !== $title) {
            $addPair($primaryArtist, $normalizedTitle);
        }
    }

    return array_values($pairs);
}

function LyricTextFromLrclibRow(array $data, bool $syncedOnly = false): ?string {
    $syncedLyrics = NormalizeLyricText($data['syncedLyrics'] ?? null);
    if ($syncedLyrics !== null) {
        return $syncedLyrics;
    }

    if ($syncedOnly) {
        return null;
    }

    return NormalizeLyricText($data['plainLyrics'] ?? null);
}

function FindLrclibLyrics(string $artist, string $title, int $timeout, bool $syncedOnly = false): ?string {
    $requests = [];
    foreach (LyricCandidatePairs($artist, $title) as $pair) {
        $query = http_build_query([
            'artist_name' => $pair['artist'],
            'track_name' => $pair['title']
        ]);
        $requests[] = [
            'url' => 'https://lrclib.net/api/get?' . $query,
            'meta' => $pair,
        ];
    }

    foreach (FetchJsonBatch($requests, $timeout) as $response) {
        $data = $response['data'] ?? null;
        $pair = $response['meta'] ?? ['artist' => $artist, 'title' => $title];
        $lyrics = is_array($data) ? LyricTextFromLrclibRow($data, $syncedOnly) : null;

        if ($lyrics !== null) {
            error_log('Lyrics found via LRCLIB exact' . ($syncedOnly ? ' synced' : '') . ': ' . $pair['artist'] . ' - ' . $pair['title']);
            return $lyrics;
        }
    }

    return null;
}

function LyricSearchScore(array $row, string $artist, string $title): int {
    $rowArtist = mb_strtolower(trim((string) ($row['artistName'] ?? '')));
    $rowTitle = mb_strtolower(trim((string) ($row['trackName'] ?? '')));
    $artist = mb_strtolower(trim($artist));
    $title = mb_strtolower(trim(NormalizeLyricTitle($title)));

    $score = 0;
    if ($rowArtist === $artist) {
        $score += 4;
    } elseif ($artist !== '' && str_contains($rowArtist, $artist)) {
        $score += 2;
    }

    if ($rowTitle === $title) {
        $score += 5;
    } elseif ($title !== '' && str_contains($rowTitle, $title)) {
        $score += 3;
    }

    if (NormalizeLyricText($row['syncedLyrics'] ?? null) !== null) {
        $score += 2;
    }

    return $score;
}

function FindLrclibSearchLyrics(string $artist, string $title, int $timeout, bool $syncedOnly = false): ?string {
    $requests = [];
    foreach (LyricCandidatePairs($artist, $title) as $pair) {
        $query = http_build_query([
            'artist_name' => $pair['artist'],
            'track_name' => $pair['title']
        ]);
        $requests[] = [
            'url' => 'https://lrclib.net/api/search?' . $query,
            'meta' => $pair,
        ];
    }

    foreach (FetchJsonBatch($requests, $timeout) as $response) {
        $data = $response['data'] ?? null;
        $pair = $response['meta'] ?? ['artist' => $artist, 'title' => $title];

        if (!is_array($data)) {
            continue;
        }

        $rows = array_values(array_filter($data, 'is_array'));
        usort($rows, static fn ($a, $b) => LyricSearchScore($b, $pair['artist'], $pair['title']) <=> LyricSearchScore($a, $pair['artist'], $pair['title']));

        foreach ($rows as $row) {
            $lyrics = LyricTextFromLrclibRow($row, $syncedOnly);
            if ($lyrics !== null) {
                error_log('Lyrics found via LRCLIB search' . ($syncedOnly ? ' synced' : '') . ': ' . ($row['artistName'] ?? $pair['artist']) . ' - ' . ($row['trackName'] ?? $pair['title']));
                return $lyrics;
            }
        }
    }

    return null;
}

function FindLyricsOvhLyrics(string $artist, string $title, int $timeout): ?string {
    $requests = [];
    foreach (LyricCandidatePairs($artist, $title) as $pair) {
        $requests[] = [
            'url' => 'https://api.lyrics.ovh/v1/' . rawurlencode($pair['artist']) . '/' . rawurlencode($pair['title']),
            'meta' => $pair,
        ];
    }

    foreach (FetchJsonBatch($requests, $timeout) as $response) {
        $data = $response['data'] ?? null;
        $pair = $response['meta'] ?? ['artist' => $artist, 'title' => $title];
        $lyrics = is_array($data) ? NormalizeLyricText($data['lyrics'] ?? null) : null;

        if ($lyrics !== null) {
            error_log('Lyrics found via lyrics.ovh: ' . $pair['artist'] . ' - ' . $pair['title']);
            return $lyrics;
        }
    }

    return null;
}

function XmlTagText(string $xml, string $tag): ?string {
    if (!preg_match('/<' . preg_quote($tag, '/') . '>\s*(.*?)\s*<\/' . preg_quote($tag, '/') . '>/is', $xml, $match)) {
        return null;
    }

    $value = trim($match[1]);
    if (preg_match('/^<!\[CDATA\[(.*)\]\]>$/s', $value, $cdata)) {
        $value = $cdata[1];
    }

    return html_entity_decode(strip_tags($value), ENT_QUOTES | ENT_XML1, 'UTF-8');
}

function FindChartLyricsLyrics(string $artist, string $title, int $timeout): ?string {
    $requests = [];
    foreach (LyricCandidatePairs($artist, $title) as $pair) {
        $query = http_build_query([
            'artist' => $pair['artist'],
            'song' => $pair['title']
        ]);
        $requests[] = [
            'url' => 'http://api.chartlyrics.com/apiv1.asmx/SearchLyricDirect?' . $query,
            'accept' => 'text/xml, application/xml, text/plain, */*',
            'meta' => $pair,
        ];
    }

    foreach (FetchHttpBatch($requests, $timeout) as $response) {
        if ($response['status'] < 200 || $response['status'] >= 300 || $response['body'] === '') {
            continue;
        }

        $pair = $response['meta'] ?? ['artist' => $artist, 'title' => $title];
        $lyrics = NormalizeLyricText(XmlTagText($response['body'], 'Lyric'));
        if ($lyrics !== null) {
            error_log('Lyrics found via ChartLyrics: ' . $pair['artist'] . ' - ' . $pair['title']);
            return $lyrics;
        }
    }

    return null;
}

function GetLyric($artist, $title)
{
    $artist = trim((string) $artist);
    $title = trim((string) $title);

    if (!IsSearchableMetadata($artist, $title)) {
        return null;
    }

    $timeout = LyricHttpTimeout();
    $providers = [
        'lrclib_synced' => static fn () => FindLrclibLyrics($artist, $title, $timeout, true),
        'lrclib_search_synced' => static fn () => FindLrclibSearchLyrics($artist, $title, $timeout, true),
        'lrclib' => static fn () => FindLrclibLyrics($artist, $title, $timeout),
        'lrclib_search' => static fn () => FindLrclibSearchLyrics($artist, $title, $timeout),
        'lyrics_ovh' => static fn () => FindLyricsOvhLyrics($artist, $title, $timeout),
        'chartlyrics' => static fn () => FindChartLyricsLyrics($artist, $title, $timeout),
    ];

    foreach (LyricProviders() as $provider) {
        if (!array_key_exists($provider, $providers)) {
            error_log('Unknown lyrics provider skipped: ' . $provider);
            continue;
        }

        $lyrics = $providers[$provider]();
        if ($lyrics !== null) {
            return $lyrics;
        }
    }

    error_log('Lyrics not found: ' . $artist . ' - ' . $title);
    return null;
}

function ControlPlayer(string $command): array {
    $allowedCommands = ['previous', 'play', 'pause', 'playPause', 'next'];
    if (!in_array($command, $allowedCommands, true)) {
        return ['status' => 'error', 'error' => 'Unknown command'];
    }

    $defaultControlUrl = 'http://127.0.0.1:' . env('PLAYER_WS_PORT', 8080) . '/control';
    $controlUrl = env('PLAYER_CONTROL_URL', $defaultControlUrl);
    $timeout = (int) env('PLAYER_CONTROL_TIMEOUT', 3);
    if ($timeout <= 0) {
        $timeout = 3;
    }

    $ch = curl_init($controlUrl);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode(['command' => $command], JSON_UNESCAPED_UNICODE));
    curl_setopt($ch, CURLOPT_TIMEOUT, $timeout);
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        'Content-Type: application/json',
        'Accept: application/json',
        'User-Agent: ' . ArtworkUserAgent()
    ]);

    $response = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlError = curl_error($ch);
    curl_close($ch);

    if ($response === false || $status < 200 || $status >= 300) {
        error_log('Player control request failed: HTTP ' . $status . ($curlError !== '' ? ' - ' . $curlError : ''));
        return [
            'status' => 'error',
            'error' => $curlError !== '' ? $curlError : 'Control endpoint returned HTTP ' . $status,
        ];
    }

    $data = json_decode($response, true);
    return is_array($data) ? $data : ['status' => 'error', 'error' => 'Invalid control response'];
}
