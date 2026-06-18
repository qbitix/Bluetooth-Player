<?php
declare(strict_types=1);

$allowedHosts = [
    'is1-ssl.mzstatic.com',
    'is2-ssl.mzstatic.com',
    'is3-ssl.mzstatic.com',
    'is4-ssl.mzstatic.com',
    'is5-ssl.mzstatic.com',
    'i.scdn.co',
    'mosaic.scdn.co',
    'coverartarchive.org',
    'archive.org',
];

function isAllowedCoverHost(string $host, array $allowedHosts): bool
{
    if (in_array($host, $allowedHosts, true)) {
        return true;
    }

    foreach (['.archive.org', '.mzstatic.com'] as $suffix) {
        if (str_ends_with($host, $suffix)) {
            return true;
        }
    }

    return false;
}

function failCoverProxy(int $status, string $message): never
{
    http_response_code($status);
    header('Content-Type: text/plain; charset=utf-8');
    echo $message;
    exit;
}

$url = (string) ($_GET['url'] ?? '');
if ($url === '') {
    failCoverProxy(400, 'Missing url');
}

$parts = parse_url($url);
$scheme = strtolower((string) ($parts['scheme'] ?? ''));
$host = strtolower((string) ($parts['host'] ?? ''));

if ($scheme !== 'https' || $host === '' || !isAllowedCoverHost($host, $allowedHosts)) {
    failCoverProxy(403, 'Cover host is not allowed');
}

$ch = curl_init($url);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
curl_setopt($ch, CURLOPT_TIMEOUT, 15);
curl_setopt($ch, CURLOPT_MAXREDIRS, 4);
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    'Accept: image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8',
    'User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari',
]);

$body = curl_exec($ch);
$status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
$contentType = (string) curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
$effectiveUrl = (string) curl_getinfo($ch, CURLINFO_EFFECTIVE_URL);
$error = curl_error($ch);
curl_close($ch);

$effectiveHost = strtolower((string) (parse_url($effectiveUrl, PHP_URL_HOST) ?: $host));
if (!isAllowedCoverHost($effectiveHost, $allowedHosts)) {
    failCoverProxy(403, 'Cover redirect host is not allowed');
}

if ($body === false || $status < 200 || $status >= 300) {
    error_log(
        '[CoverProxy] request failed: HTTP ' . $status .
        ' url=' . $url .
        ' effective=' . $effectiveUrl .
        ' content_type=' . ($contentType !== '' ? $contentType : '<empty>') .
        ($error !== '' ? ' error=' . $error : '')
    );
    failCoverProxy(502, 'Could not load cover image');
}

if (!str_starts_with(strtolower($contentType), 'image/')) {
    error_log('[CoverProxy] non-image response: HTTP ' . $status . ' url=' . $url . ' content_type=' . ($contentType !== '' ? $contentType : '<empty>'));
    failCoverProxy(415, 'Remote resource is not an image');
}

header('Content-Type: ' . $contentType);
header('Cache-Control: public, max-age=86400');
header('Access-Control-Allow-Origin: *');
echo $body;
