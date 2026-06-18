<?php
header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
require 'func.php';

function hasSearchableMetadata(string $artist, string $title): bool
{
    $unknownValues = ['', 'unknown', 'unknown artist', 'unknown title'];
    return !in_array(strtolower(trim($artist)), $unknownValues, true)
        && !in_array(strtolower(trim($title)), $unknownValues, true);
}

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'Method not allowed. Use POST.']);
    exit;
}
$input = file_get_contents('php://input');
$data = json_decode($input, true);

if (!is_array($data)) {
    http_response_code(400);
    echo json_encode(['error' => 'Invalid JSON']);
    exit;
}

$action = $data['action'] ?? null;

switch ($action) {
    case 'playStats':
        $playerData = GetData();
        echo json_encode([
            'status' => 'ok',
            'data' => $playerData
        ], JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
        break;

    case 'GetArt':
        $artist = trim((string) ($data['artist'] ?? ''));
        $title  = trim((string) ($data['title'] ?? ''));

        if ($artist === '' || $title === '') {
            $playerData = GetData();
            $artist = $playerData['artist'] ?? '';
            $title  = $playerData['title'] ?? '';
        }

        if (!hasSearchableMetadata($artist, $title)) {
            echo json_encode([
                'status' => 'not_found',
                'reason' => 'unknown_metadata',
                'artist' => $artist,
                'title' => $title,
                'link' => ''
            ], JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
            break;
        }

        $link = GetArt($artist, $title);
        echo json_encode([
            'status' => $link === '' ? 'not_found' : 'ok',
            'artist' => $artist,
            'title' => $title,
            'link' => $link
        ], JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
        break;

    case 'GetLyric':
        $artist = trim((string) ($data['artist'] ?? ''));
        $title  = trim((string) ($data['title'] ?? ''));

        if ($artist === '' || $title === '') {
            $playerData = GetData();
            $artist = $playerData['artist'] ?? '';
            $title  = $playerData['title'] ?? '';
        }

        if (!hasSearchableMetadata($artist, $title)) {
            echo json_encode([
                'status' => 'not_found',
                'reason' => 'unknown_metadata',
                'message' => 'Metadata is unknown',
                'artist' => $artist,
                'title' => $title
            ], JSON_UNESCAPED_UNICODE);
            break;
        }

        $lyric = GetLyric($artist, $title);

        if (!$lyric) {
            echo json_encode([
                'status' => 'not_found',
                'message' => 'Lyrics not found',
                'artist' => $artist,
                'title' => $title
            ], JSON_UNESCAPED_UNICODE);
            break;
        }

        echo json_encode([
            'status' => 'ok',
            'artist' => $artist,
            'title'  => $title,
            'lyrics' => $lyric
        ], JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
        break;

    case 'PlayerCommand':
        $command = (string) ($data['command'] ?? '');
        $result = ControlPlayer($command);

        if (($result['status'] ?? '') !== 'ok') {
            http_response_code(400);
        }

        echo json_encode($result, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
        break;

    default:
        http_response_code(400);
        echo json_encode(['error' => 'Unknown action']);
        break;
}
