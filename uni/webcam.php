<?php



$x = isset($_GET['x']) ? $_GET['x'] : 25;
$y = isset($_GET['y']) ? $_GET['y'] : 25;
$w = isset($_GET['w']) ? $_GET['w'] : 25;
$h = isset($_GET['h']) ? $_GET['h'] : 25;

?>
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Display Webcam Stream</title>
 
<style>
body {
padding: 0px;
margin: 0px;
}
.logo{
	width: 100%;
	height: 14rem;
	background-image: url("./rogueye.png");
	background-position: center;
	background-repeat: no-repeat;
	background-size: contain;
}
#container {
}
#videoElement {
	width: 100%;
	height: 100%;
	background-color: #666;
}
.bounding-box {
    border: red 10px solid
}
.box-1 {
    position: absolute;
    top: <?php print($y); ?>%;
    left: <?php print($x); ?>%;
    width: <?php print($w); ?>%;
    height: <?php print($h); ?>%;
}
.button {
	width: 100%;
	height: 300px;
}
</style>
</head>
 
<body>
<div class="logo">
</div>

<div id="container">
	<video autoplay="true" id="videoElement">
	
	</video>
</div>
<div id="box-1" class="box-1 bounding-box"></div>
<div onclick="document.getElementById('box-1').hidden = !document.getElementById('box-1').hidden" class="button"></div>
<script>
var video = document.querySelector("#videoElement");

if (navigator.mediaDevices.getUserMedia) {
  navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
    .then(function (stream) {
      video.srcObject = stream;
    })
    .catch(function (err0r) {
      console.log("Something went wrong!");
    });
}

// Make the DIV element draggable:
dragElement(document.getElementById("box-1"));

function dragElement(elmnt) {
  var pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
  if (document.getElementById(elmnt.id + "header")) {
    // if present, the header is where you move the DIV from:
    document.getElementById(elmnt.id + "header").onmousedown = dragMouseDown;
  } else {
    // otherwise, move the DIV from anywhere inside the DIV:
    elmnt.onmousedown = dragMouseDown;
  }

  function dragMouseDown(e) {
    e = e || window.event;
    e.preventDefault();
    // get the mouse cursor position at startup:
    pos3 = e.clientX;
    pos4 = e.clientY;
    document.onmouseup = closeDragElement;
    // call a function whenever the cursor moves:
    document.onmousemove = elementDrag;
  }

  function elementDrag(e) {
    e = e || window.event;
    e.preventDefault();
    // calculate the new cursor position:
    pos1 = pos3 - e.clientX;
    pos2 = pos4 - e.clientY;
    pos3 = e.clientX;
    pos4 = e.clientY;
    // set the element's new position:
    elmnt.style.top = (elmnt.offsetTop - pos2) + "px";
    elmnt.style.left = (elmnt.offsetLeft - pos1) + "px";
  }

  function closeDragElement() {
    // stop moving when mouse button is released:
    document.onmouseup = null;
    document.onmousemove = null;
  }
}
</script>
</body>
</html>
