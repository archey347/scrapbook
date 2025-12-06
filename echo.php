<?php

header("Content-Type: application/json");

print(json_encode(
	[
		"method" => $_SERVER['REQUEST_METHOD'],
		"host"   => $_SERVER['HTTP_HOST'],
		"url"    => $_SERVER['REQUEST_URI'],
		"ip"	   => $_SERVER['REMOTE_ADDR'],
		"post"   => $_POST,
		"get"    => $_GET,
	])
);
