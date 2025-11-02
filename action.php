<?php
header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
require 'func.php';

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'Метод не разрешён. Используйте POST.']);
    exit;
}
$input = file_get_contents('php://input');
$data = json_decode($input, true);

if (!is_array($data)) {
    http_response_code(400);
    echo json_encode(['error' => 'Некорректный JSON']);
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
        $playerData = GetData();
        $artist = $playerData['artist'] ?? '';
        $title  = $playerData['title'] ?? '';
        $link = GetArt($artist, $title);
        echo json_encode([
            'status' => 'ok',
            'artist' => $artist,
            'title' => $title,
            'link' => $link
        ], JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
        break;

    case 'GetLyric':
    $playerData = GetData();
    $artist = $playerData['artist'] ?? '';
    $title  = $playerData['title'] ?? '';
    $lyric  = GetLyric($artist, $title);

    if (!$lyric) {
        echo json_encode([
            'status' => 'error',
            'message' => 'Текст не найден'
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

    

    default:
        http_response_code(400);
        echo json_encode(['error' => 'Неизвестное действие']);
        break;
}
