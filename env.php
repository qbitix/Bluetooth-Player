<?php
declare(strict_types=1);

/**
 * Lightweight .env loader for simple PHP projects.
 */
if (!function_exists('load_env_file')) {
    /**
     * Loads environment variables from the given .env file.
     *
     * @param string|null $path Absolute path to the .env file. Defaults to project root.
     */
    function load_env_file(?string $path = null): void
    {
        static $loaded = [];

        $path = $path ?? __DIR__ . '/.env';

        if (isset($loaded[$path])) {
            return;
        }

        $loaded[$path] = true;

        if (!is_readable($path)) {
            return;
        }

        $lines = file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
        if ($lines === false) {
            return;
        }

        foreach ($lines as $line) {
            $trimmed = ltrim($line);
            if ($trimmed === '' || $trimmed[0] === '#') {
                continue;
            }

            if (!str_contains($line, '=')) {
                continue;
            }

            [$name, $value] = explode('=', $line, 2);
            $name = trim($name);
            $value = trim($value);

            if ($name === '') {
                continue;
            }

            if ($value !== '' && ($value[0] === '"' || $value[0] === "'")) {
                $quote = $value[0];
                if (substr($value, -1) === $quote) {
                    $value = substr($value, 1, -1);
                }
            }

            $_ENV[$name] = $value;
            putenv($name . '=' . $value);
        }
    }
}

if (!function_exists('env')) {
    /**
     * Returns an environment variable, loading the default .env file on demand.
     *
     * @param string $key
     * @param mixed $default
     * @param string|null $path
     * @return mixed
     */
    function env(string $key, mixed $default = null, ?string $path = null): mixed
    {
        load_env_file($path);

        if (array_key_exists($key, $_ENV)) {
            return $_ENV[$key];
        }

        $value = getenv($key);

        return $value === false ? $default : $value;
    }
}
