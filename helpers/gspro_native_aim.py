"""Auto Aim step 1: where Looper WOULD click on GSPro's minimap. No input.

GSPro draws the minimap as a top-down, north-not-necessarily-up view that it
rotates and zooms every shot so the ball (red dot) sits low and the pin
(white dot) sits high on one vertical line. Looper knows both points exactly in
GSPro world metres (currentRound EndingPOS / GKD tee, and the GKD pin slot),
so the two dots fix the minimap's scale, rotation and offset for THIS frame:

    pixel = a * (x - i z) + b        (complex numbers; a = scale+rotation)

Checked on five real FarmLinks frames (deep rough, trees, bunker, fairway,
tee): OSM bunker centroids mapped this way land on sand-coloured pixels; the
mirrored alternative lands on grass. No waypoint labels are read.

The frame never leaves this process except as a small annotated crop of the
minimap returned to the Looper page on this PC.
"""
from __future__ import annotations

import base64
import math
from dataclasses import dataclass

import cv2
import numpy as np

import gspro_minimap_markers as markers

RIGHT_MINIMAP_ROI = (0.848, 0.520, 0.995, 0.960)
#: The same place mirrored: GSPro lets the player put the minimap on the left.
#: Confirmed on a real 3834 x 2144 capture (19 Nov 2026): ball at 50.5% across and
#: 91.1% down this crop, pin at 50.5% and 19.3%, the same as on the right.
LEFT_MINIMAP_ROI = (0.005, 0.520, 0.152, 0.960)
#: Where the pair sits on the map, as shares of its height and width.
BALL_MIN_DOWN = 0.70
PIN_MAX_DOWN = 0.50
MIN_PIN_TO_BALL_DOWN = 0.30
MAX_BALL_OFF_PIN_LINE = 0.15
METERS_TO_YARDS = 1.0936132983377078
# The red ball dot is ~18 px on a 3760 px wide window: ~3.3% of the minimap width.
BALL_DOT_FRACTION = 0.033
#: How far down the minimap GSPro draws the ball in its usual layout.
BALL_USUAL_DOWN = (0.87, 0.94)
MIN_BALL_PIN_PX = 60.0
MAX_ALIGNMENT_RATIO = 0.08


@dataclass(frozen=True)
class Pixel:
    x: float
    y: float


def crop_minimap(frame_bgr: np.ndarray, roi=RIGHT_MINIMAP_ROI):
    height, width = frame_bgr.shape[:2]
    x1, y1, x2, y2 = roi
    x0, y0 = int(width * x1), int(height * y1)
    xe, ye = int(width * x2), int(height * y2)
    if xe - x0 < 60 or ye - y0 < 90:
        raise ValueError("Minimap crop is too small")
    return frame_bgr[y0:ye, x0:xe].copy(), (x0, y0)


class AimReadError(RuntimeError):
    """The minimap could not be read. `seen` is a small PNG (base64) of where Looper looked."""

    def __init__(self, message: str, seen: str | None = None):
        super().__init__(message)
        self.seen = seen


#: GSPro's eight ball colours, from its own colour picker (Brian, 19 Nov 2026), as OpenCV
#: hue / saturation / value: red (2, 209, 209), green (68, 221, 164), blue (104, 255, 242),
#: yellow (22, 202, 242), pink (156, 183, 227), teal (93, 224, 179), purple (144, 183, 163),
#: orange (19, 238, 193). There is no white ball.
def _ball_colour_masks(hsv: np.ndarray) -> list[np.ndarray]:
    """One mask per ball colour, each searched on its own.

    Kept apart so a dot is never merged with a differently coloured patch it
    sits on (a red dot on a tan path). Red is as measured on 12 real captures
    (#ff403d to #cf322a). The rest are set around the picker's colours and
    away from the course as the minimap draws it: grass is the same hue as the
    green ball but darker (value 91 typical, 127 at the 95th percentile,
    against the ball's 164), and water is darker still.
    """
    def band(low, high, sat, val):
        return cv2.inRange(hsv, np.array([low, sat, val]), np.array([high, 255, 255]))
    return [
        cv2.bitwise_or(band(0, 12, 120, 100), band(170, 179, 120, 100)),   # red
        band(13, 30, 170, 170),                                           # orange, yellow
        band(45, 85, 120, 140),                                           # green (real dot: 67, 208, 248 in the
                                                                          # middle, softer at its edge)
        band(86, 99, 120, 140),                                           # teal
        band(100, 118, 180, 180),                                         # blue
        band(131, 169, 140, 130),                                         # purple, pink
    ]


#: The player's name banner in the top left of GSPro's window is drawn in the player's ball
#: colour, and stays there whichever side the minimap is on. Reading it says which colour
#: of dot to look for.
PLAYER_BANNER_ROI = (0.025, 0.024, 0.15, 0.052)


def read_player_colour(frame_bgr: np.ndarray) -> int | None:
    """The hue (OpenCV 0-179) of the player's banner, or None when it cannot be read."""
    height, width = frame_bgr.shape[:2]
    x1, y1, x2, y2 = PLAYER_BANNER_ROI
    patch = frame_bgr[int(height * y1):int(height * y2), int(width * x1):int(width * x2)]
    if patch.size == 0:
        return None
    hsv = cv2.cvtColor(patch, cv2.COLOR_BGR2HSV).reshape(-1, 3)
    vivid = hsv[(hsv[:, 1] >= 110) & (hsv[:, 2] >= 140)]   # every ball colour is brighter than grass
    if len(vivid) < 0.5 * len(hsv):       # the banner is a solid block of colour behind the name
        return None
    # Red sits at both ends of the hue scale: take the median on a circle.
    angles = vivid[:, 0].astype(np.float64) * (math.pi / 90.0)
    mean = math.atan2(np.sin(angles).mean(), np.cos(angles).mean())
    return int(round((mean * 90.0 / math.pi) % 180)) % 180


def _hue_mask(hsv: np.ndarray, hue: int, spread: int = 12, sat: int = 110, val: int = 120) -> np.ndarray:
    """Vivid pixels within `spread` of this hue (wrapping at red)."""
    low, high = hue - spread, hue + spread
    def band(a, b):
        return cv2.inRange(hsv, np.array([a, sat, val]), np.array([b, 255, 255]))
    if low < 0:
        return cv2.bitwise_or(band(0, high), band(180 + low, 179))
    if high > 179:
        return cv2.bitwise_or(band(low, 179), band(0, high - 180))
    return band(low, high)


def find_ball_dot(roi: np.ndarray, pin: Pixel, hue: int | None = None) -> Pixel:
    """The ball dot, found by where it must be as well as what it looks like.

    GSPro draws the minimap with the pin near the top and the ball straight
    below it near the bottom (12 real captures: ball 51-58% across and 90-92%
    down, pin within half a percent of the same line, dot 3.2% of the minimap's
    width). So: a compact round dot of a ball colour, of that size, in the
    lower part of the map, close to the pin's vertical line. Hazard lines are
    long and thin and fail on size and shape.
    """
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    h, w = hsv.shape[:2]
    expected = max(6.0, BALL_DOT_FRACTION * w)
    # With the player's colour known, only a dot of that colour will do.
    masks = [_hue_mask(hsv, hue)] if hue is not None else _ball_colour_masks(hsv)
    shine = cv2.inRange(hsv[:, :, 2], 170, 255)   # a lit ball's light spot, any colour
    try:
        return _best_ball_dot(masks, pin, h, w, expected, shine)
    except RuntimeError:
        if hue is None:
            raise
    # Some courses (Payne's Valley) draw the dot as a lit ball: its top half is
    # dark (a purple dot's top is value 71). Look again with dark pixels of the
    # same strong colour allowed in.
    try:
        return _best_ball_dot([_hue_mask(hsv, hue, spread=16, sat=150, val=55)], pin, h, w, expected, shine)
    except RuntimeError:
        pass
    # A dull scene dims the ball as it dims the pin. Where GSPro puts the ball in its usual layout
    # (35 real captures: 89.5% to 91.6% down in 33 of them), a round dot of the player's hue is the
    # ball even when its colour is washed out. Only there: grass shares the green ball's hue.
    usual = _hue_mask(hsv, hue, spread=18, sat=80, val=50)
    usual[: int(BALL_USUAL_DOWN[0] * h), :] = 0
    usual[int(BALL_USUAL_DOWN[1] * h):, :] = 0
    return _best_ball_dot([usual], pin, h, w, expected, shine)


def _best_ball_dot(masks, pin: Pixel, h: int, w: int, expected: float, shine: np.ndarray) -> Pixel:
    contours = [(contour, mask) for mask in masks
                for contour in cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0]]
    best: tuple[float, Pixel] | None = None
    for contour, mask in contours:
        x, y, cw, ch = cv2.boundingRect(contour)
        if not (0.5 * expected <= cw <= 1.8 * expected and 0.5 * expected <= ch <= 1.8 * expected):
            continue
        area = cv2.contourArea(contour)
        perimeter = cv2.arcLength(contour, True)
        circularity = 4 * math.pi * area / (perimeter * perimeter) if perimeter else 0.0
        if circularity < 0.55:
            continue
        m = cv2.moments(contour)
        if m["m00"] == 0:
            continue
        cx, cy = m["m10"] / m["m00"], m["m01"] / m["m00"]
        # A dot is solid: it fills its own outline and its box as a disc does (0.79).
        # The letter "o" in on-screen text is a ring and fails both. A shine can sit
        # right in the middle of the dot (Payne's Valley, 19 Nov), so the test is how
        # much of the outline is the dot's colour or bright; an "o" has dark grass inside.
        outline = np.zeros((ch, cw), np.uint8)
        cv2.drawContours(outline, [contour], -1, 255, -1, offset=(-x, -y))
        inside = cv2.countNonZero(outline)
        if not inside or cv2.countNonZero(cv2.bitwise_and(outline, cv2.bitwise_or(
                mask[y:y + ch, x:x + cw], shine[y:y + ch, x:x + cw]))) < 0.85 * inside:
            continue
        if cv2.countNonZero(mask[y:y + ch, x:x + cw]) < 0.62 * cw * ch:
            continue
        if cy < BALL_MIN_DOWN * h or cy - pin.y < MIN_PIN_TO_BALL_DOWN * h:
            continue
        if abs(cx - pin.x) > MAX_BALL_OFF_PIN_LINE * w:
            continue
        score = abs(cx - pin.x) / max(cy - pin.y, 1.0) - 0.2 * circularity
        if best is None or score < best[0]:
            best = (score, Pixel(float(cx), float(cy)))
    if best is None:
        raise RuntimeError("Could not find GSPro's ball dot under the pin on the minimap")
    return best[1]


#: Kept for callers of the old name.
find_red_ball_dot = find_ball_dot


#: The pin search looks for circles of a fixed size in pixels, set up on a 4K
#: screen where the minimap is this wide. Smaller screens are enlarged to it.
PIN_SEARCH_WIDTH = 565
#: Where GSPro draws the pin (18-22% down every capture) and how far either side
#: of the ball's line to look for it, as shares of the minimap.
PIN_TYPICAL_DOWN = 0.19
PIN_STRIP_HALF_WIDTH = 0.08


def _pin_candidates(roi: np.ndarray, minimap_width: int | None = None):
    """GSPro's white pin marker, at any screen size: enlarged to 4K size first, then as it is."""
    scale = PIN_SEARCH_WIDTH / max(minimap_width or roi.shape[1], 1)
    if scale >= 1.15:
        try:
            enlarged = cv2.resize(roi, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
            point = markers.detect_pin_marker(enlarged)
            yield Pixel(float(point.x) / scale, float(point.y) / scale)
        except Exception:  # the pin detector raises its own types
            pass
    point = markers.detect_pin_marker(roi)
    yield Pixel(float(point.x), float(point.y))


def _ball_under(roi: np.ndarray, pin: Pixel, hue: int | None) -> Pixel:
    if pin.y > PIN_MAX_DOWN * roi.shape[0]:
        raise RuntimeError("The white marker is too low on the map to be GSPro's pin")
    try:
        return find_ball_dot(roi, pin, hue)
    except RuntimeError:
        if hue is None:
            raise
        return find_ball_dot(roi, pin)   # the banner was misread or hidden: try every ball colour


def _lined_up(ball: Pixel, pin: Pixel) -> bool:
    return abs(ball.x - pin.x) <= MAX_ALIGNMENT_RATIO * max(ball.y - pin.y, 1.0)


def _pin_above(roi: np.ndarray, ball: Pixel) -> Pixel:
    """The pin, looked for only in a strip straight above the ball, where GSPro always draws it.

    Light sand bunkers round a green can outshine a shaded pin (Payne's Valley);
    off this strip they are never considered.
    """
    h, w = roi.shape[:2]
    half = max(12, int(PIN_STRIP_HALF_WIDTH * w))
    x0, x1 = max(0, int(ball.x) - half), min(w, int(ball.x) + half)
    strip = roi[: int(PIN_MAX_DOWN * h), x0:x1]
    failure: Exception | None = None
    try:
        for pin in _pin_candidates(strip, minimap_width=w):
            pin = Pixel(pin.x + x0, pin.y)
            if pin.y <= MINIMAP_HEADER * h:
                continue   # white letters in the minimap's title, never the pin
            if _lined_up(ball, pin):
                return pin
            failure = failure or RuntimeError("The white marker above the ball is not in line with it")
    except Exception as error:  # the pin detector raises its own types when nothing is white enough
        failure = failure or error
    placed = _pin_by_location(roi, ball)
    if placed is not None:
        return placed
    raise failure or RuntimeError("Could not detect white pin marker.")


#: Where GSPro draws the pin in its usual layout (35 real captures, 23 Nov 2026): 17.7% to 19.8%
#: down the minimap in 33 of them, and never more than half a percent of the ball-to-pin distance
#: off the ball's vertical line. A dot here is the pin whatever its colour. Off the tee GSPro's aim
#: marker sits on the same line a little lower (24.6% down on two par 5s): outside this band.
PIN_USUAL_DOWN = (0.165, 0.21)
PIN_USUAL_OFF_LINE = 0.015
#: A dot counts when it is this much brighter than the ground round it (0-255). Tried from the
#: lowest up: a pin touching sand is one blob with it until the level passes the sand's brightness.
BRIGHTER_BY = (22, 45, 70, 100)


def _bright_round_dots(roi: np.ndarray, expected: float) -> list[Pixel]:
    """Solid round dots of the ball's size that are brighter than the ground round them, any colour.

    GSPro lights the minimap's dots with the scene: a pin can be white, grey in shade (Bethpage
    Black, 23 Nov 2026: dimmer than the sand beside it) or tinted by a low sun. What stays true is
    that it is a small round dot standing out from the grass under it. The ground is taken as the
    middle brightness of a patch about four dots wide, so sand or a white line nearby doesn't hide it.
    """
    value = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)[:, :, 2]
    patch = max(9, int(4 * expected)) | 1
    ground = cv2.medianBlur(value, min(patch, 255))
    above = value.astype(np.int16) - ground.astype(np.int16)
    found: list[Pixel] = []
    for level in BRIGHTER_BY:
        mask = (above > level).astype(np.uint8) * 255
        for _, dot in _solid_round_dots(mask, expected):
            if all(math.hypot(dot.x - seen.x, dot.y - seen.y) > 0.5 * expected for seen in found):
                found.append(dot)
    return found


def _in_aim_ring(hsv: np.ndarray, dot: Pixel, expected: float) -> bool:
    """GSPro's aim marker: a dot inside a magenta ring. Never the pin."""
    h, w = hsv.shape[:2]
    r = int(round(1.2 * expected))
    x0, x1 = max(0, int(dot.x) - r), min(w, int(dot.x) + r + 1)
    y0, y1 = max(0, int(dot.y) - r), min(h, int(dot.y) + r + 1)
    patch = hsv[y0:y1, x0:x1]
    if patch.size == 0:
        return False
    magenta = cv2.inRange(patch, np.array([135, 110, 110]), np.array([172, 255, 255]))
    return cv2.countNonZero(magenta) >= 0.06 * patch.shape[0] * patch.shape[1]


def _pin_by_location(roi: np.ndarray, ball: Pixel) -> Pixel | None:
    """The pin from where it has to be, not from its colour: straight above the ball.

    One bright round dot on the ball's line at the usual height is the pin. With none there,
    a single one anywhere on the line above the ball is taken. Two that could be it: neither.
    GSPro's blue aim disc is never taken for the pin: aimed near the flag it hides the pin dot
    (DPC Sodgrass 1, 23 Nov 2026) and its centre can be yards off it.
    """
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    h, w = hsv.shape[:2]
    expected = max(6.0, BALL_DOT_FRACTION * w)
    half = max(12, int(PIN_STRIP_HALF_WIDTH * w))
    # Room either side of the strip so the ground round a dot at its edge is still seen.
    pad = int(3 * expected)
    x0, x1 = max(0, int(ball.x) - half - pad), min(w, int(ball.x) + half + pad)
    top, bottom = int(MINIMAP_HEADER * h), int(PIN_MAX_DOWN * h)
    dots = [Pixel(dot.x + x0, dot.y + top) for dot in _bright_round_dots(roi[top:bottom, x0:x1], expected)]
    on_line = [dot for dot in dots
               if abs(dot.x - ball.x) <= PIN_USUAL_OFF_LINE * max(ball.y - dot.y, 1.0)
               and ball.y - dot.y >= MIN_BALL_PIN_PX and not _in_aim_ring(hsv, dot, expected)]
    usual = [dot for dot in on_line if PIN_USUAL_DOWN[0] * h <= dot.y <= PIN_USUAL_DOWN[1] * h]
    if usual:
        return usual[0] if len(usual) == 1 else None
    # Zoomed in with the pair still on one vertical line: the pin is higher or lower than usual.
    return on_line[0] if len(on_line) == 1 else None


#: GSPro's minimap zooms from a whole par 5 down to a green; outside this the pair is not a minimap.
FREE_PAIR_YARDS_PER_PIXEL = (0.03, 1.2)
#: Header band at the top of the minimap ("Fairway", "Green"...): white letters, never the pin.
MINIMAP_HEADER = 0.115


def _solid_round_dots(mask: np.ndarray, expected: float, shine: np.ndarray | None = None) -> list[tuple[float, Pixel]]:
    """Every compact, solid, round dot of the mask's colour at the ball's size: (roundness, centre)."""
    found: list[tuple[float, Pixel]] = []
    for contour in cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0]:
        x, y, cw, ch = cv2.boundingRect(contour)
        if not (0.5 * expected <= cw <= 1.8 * expected and 0.5 * expected <= ch <= 1.8 * expected):
            continue
        area = cv2.contourArea(contour)
        perimeter = cv2.arcLength(contour, True)
        circularity = 4 * math.pi * area / (perimeter * perimeter) if perimeter else 0.0
        if circularity < 0.6:
            continue
        m = cv2.moments(contour)
        if m["m00"] == 0:
            continue
        outline = np.zeros((ch, cw), np.uint8)
        cv2.drawContours(outline, [contour], -1, 255, -1, offset=(-x, -y))
        inside = cv2.countNonZero(outline)
        fill = mask[y:y + ch, x:x + cw]
        if shine is not None:
            fill = cv2.bitwise_or(fill, shine[y:y + ch, x:x + cw])
        if not inside or cv2.countNonZero(cv2.bitwise_and(outline, fill)) < 0.85 * inside:
            continue
        if cv2.countNonZero(mask[y:y + ch, x:x + cw]) < 0.6 * cw * ch:
            continue
        found.append((circularity, Pixel(m["m10"] / m["m00"], m["m01"] / m["m00"])))
    return found


def find_free_pair(roi: np.ndarray, hue: int | None) -> tuple[Pixel, Pixel]:
    """Ball and pin wherever GSPro drew them: no "pin straight above the ball" assumed.

    GSPro only draws the pair on one vertical line for a full shot down a hole.
    Around the green it zooms in and the ball sits mid-map; on some par 3 tees
    the whole hole is drawn at an angle (FarmLinks 3, 4 and 5, 21 Nov 2026).
    There the pair is found by what the dots are: one round dot in the player's
    ball colour and one round white dot of the same size. Bunkers are far too
    big, hazard lines too long, letters are rings or not round. It needs the
    player's colour from the banner, and exactly one of each dot: anything
    less sure is refused.
    """
    if hue is None:
        raise RuntimeError("Could not read the player's ball colour, so the ball can't be told from the map")
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    h, w = hsv.shape[:2]
    expected = max(6.0, BALL_DOT_FRACTION * w)
    top = int(MINIMAP_HEADER * h)
    shine = cv2.inRange(hsv[:, :, 2], 170, 255)
    # Inside the map itself: under the header, and off the crop's side edges, where dots from
    # GSPro's putting grid on the main screen can show (FarmLinks 3 green, 21 Nov).
    edge = 0.05 * w
    below_header = lambda dots: [d for d in dots if d[1].y > top and edge < d[1].x < w - edge]  # noqa: E731
    balls = below_header(_solid_round_dots(_hue_mask(hsv, hue), expected, shine))
    if not balls:
        balls = below_header(_solid_round_dots(_hue_mask(hsv, hue, spread=16, sat=150, val=55), expected, shine))
    if len(balls) != 1:
        raise RuntimeError("Could not find one ball dot in the player's colour on the minimap"
                           if not balls else "More than one dot in the player's ball colour on the minimap")
    ball = balls[0][1]
    white = cv2.inRange(hsv, np.array([0, 0, 215]), np.array([179, 60, 255]))
    pins = [d for d in below_header(_solid_round_dots(white, expected))
            if math.hypot(d[1].x - ball.x, d[1].y - ball.y) >= MIN_BALL_PIN_PX]
    if not pins:
        # No white dot (a pin in shade or tinted light): any one round dot brighter than its ground
        # that isn't the ball or GSPro's aim marker.
        pins = [(0.0, dot) for dot in _bright_round_dots(roi, expected)
                if dot.y > top and edge < dot.x < w - edge
                and math.hypot(dot.x - ball.x, dot.y - ball.y) >= MIN_BALL_PIN_PX
                and not _in_aim_ring(hsv, dot, expected)]
    if len(pins) != 1:
        raise RuntimeError("Could not find GSPro's white pin dot on the minimap"
                           if not pins else "More than one white dot that could be the pin on the minimap")
    return ball, pins[0][1]


def find_ball_and_pin_any(roi: np.ndarray, hue: int | None = None) -> tuple[Pixel, Pixel, str]:
    """The pair and how it was found: "vertical" (GSPro's usual layout) or "free" (anywhere on the map)."""
    try:
        ball, pin = find_ball_and_pin(roi, hue)
        if _lined_up(ball, pin):
            return ball, pin, "vertical"
        usual: Exception | None = RuntimeError("The pair found is not on one vertical line")
        unaligned: tuple[Pixel, Pixel] | None = (ball, pin)
    except Exception as error:  # the pin detector raises its own types
        usual, unaligned = error, None
    try:
        ball, pin = find_free_pair(roi, hue)
        return ball, pin, "free"
    except RuntimeError as error:
        if unaligned is not None:
            return unaligned[0], unaligned[1], "vertical"   # as before: the alignment check refuses it
        raise RuntimeError(f"{str(usual)[:70]}; {str(error)[:70]}") from error


def find_ball_and_pin(roi: np.ndarray, hue: int | None = None) -> tuple[Pixel, Pixel]:
    """Pin and ball as a pair: a white marker in the upper part of the map with a ball dot under it.

    A white shape with no ball under it (text, a data tile) is not a minimap.
    First the pin, then the ball under it; if that gives no pair in line the way
    GSPro draws it, the ball first (its colour is known), then the pin above it.
    """
    failure: Exception | None = None
    unaligned: tuple[Pixel, Pixel] | None = None
    try:
        for pin in _pin_candidates(roi):
            try:
                ball = _ball_under(roi, pin, hue)
            except RuntimeError as error:
                failure = failure or error
                continue
            if _lined_up(ball, pin):
                return ball, pin
            unaligned = unaligned or (ball, pin)
    except Exception as error:  # no white marker anywhere (a pin in shade): the ball-first search still runs
        failure = failure or error
    try:
        h, w = roi.shape[:2]
        ball = _ball_under(roi, Pixel(w / 2.0, PIN_TYPICAL_DOWN * h), hue)
        return ball, _pin_above(roi, ball)
    except RuntimeError as error:
        if unaligned is not None:
            return unaligned   # the page's alignment check says what is wrong
        raise failure or error


def locate_minimap(frame_bgr: np.ndarray, roi=None):
    """Find the minimap on this frame: (crop, (x0, y0), ball, pin, side, roi)."""
    return locate_minimap_pair(frame_bgr, roi)[:6]


def locate_minimap_pair(frame_bgr: np.ndarray, roi=None):
    """Find the minimap on this frame: bottom right first, then the same place on the left.

    Returns (crop, (x0, y0), ball, pin, side, roi, pairing). The left position is the right
    one mirrored; GSPro lets the player put the minimap on either side. `pairing` is
    "vertical" or "free" (see find_ball_and_pin_any).
    """
    sides = (("given", roi),) if roi is not None else (("right", RIGHT_MINIMAP_ROI), ("left", LEFT_MINIMAP_ROI))
    looked: list[np.ndarray] = []
    reasons: list[str] = []
    hue = read_player_colour(frame_bgr)
    for side, candidate in sides:
        crop, origin = crop_minimap(frame_bgr, candidate)
        try:
            ball, pin, pairing = find_ball_and_pin_any(crop, hue)
            return crop, origin, ball, pin, side, candidate, pairing
        except Exception as error:  # the pin detector raises its own types
            looked.append(crop)
            # Always name the error: some (MemoryError, a bare assert) have no message.
            reasons.append(f"{side}: {str(error)[:70] or type(error).__name__}")
    where = "where told" if roi is not None else "bottom right or bottom left"
    seen = None
    try:
        height = min(c.shape[0] for c in looked)
        seen = _png_base64(np.hstack([c[:height] for c in looked]), max_width=420)
    except Exception:
        seen = None
    # Reasons first, so a shortened message still says why each side failed.
    raise AimReadError("; ".join(reasons) + f" (no minimap found {where})", seen)


def _complex_world(x: float, z: float) -> complex:
    # Top-down, not mirrored: east right, north up (image y grows downward).
    return complex(x, -z)


@dataclass(frozen=True)
class MinimapFrame:
    a: complex
    b: complex

    def to_pixel(self, x: float, z: float) -> Pixel:
        q = self.a * _complex_world(x, z) + self.b
        return Pixel(q.real, q.imag)

    def to_world(self, px: Pixel) -> tuple[float, float]:
        w = (complex(px.x, px.y) - self.b) / self.a
        return w.real, -w.imag

    @property
    def yards_per_pixel(self) -> float:
        return METERS_TO_YARDS / abs(self.a)


def solve_minimap_frame(ball_world, pin_world, ball_px: Pixel, pin_px: Pixel) -> MinimapFrame:
    wb, wp = _complex_world(*ball_world), _complex_world(*pin_world)
    pb, pp = complex(ball_px.x, ball_px.y), complex(pin_px.x, pin_px.y)
    if abs(wp - wb) < 1.0:
        raise ValueError("Ball and pin are too close to fix the minimap scale")
    a = (pp - pb) / (wp - wb)
    return MinimapFrame(a=a, b=pb - a * wb)


def _png_base64(image: np.ndarray, max_width: int = 320) -> str:
    h, w = image.shape[:2]
    if w > max_width:
        image = cv2.resize(image, (max_width, int(h * max_width / w)), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".png", image)
    if not ok:
        raise RuntimeError("Could not encode preview image")
    return base64.b64encode(buf.tobytes()).decode("ascii")


def aim_preview(frame_bgr: np.ndarray, *, ball_world, pin_world, target_world, roi=None) -> dict:
    """Where Looper would click for target_world on this frame. Read-only."""
    for value in (*ball_world, *pin_world, *target_world):
        if not math.isfinite(value):
            raise ValueError("Non-finite world coordinate")
    crop, (x0, y0), ball_px, pin_px, side, used_roi, pairing = locate_minimap_pair(frame_bgr, roi)
    separation = math.hypot(pin_px.x - ball_px.x, pin_px.y - ball_px.y)
    if separation < MIN_BALL_PIN_PX:
        raise RuntimeError("Ball and pin dots are too close on the minimap to aim precisely")
    alignment = abs(pin_px.x - ball_px.x) / separation
    frame = solve_minimap_frame(ball_world, pin_world, ball_px, pin_px)
    target_px = frame.to_pixel(*target_world)
    h, w = crop.shape[:2]
    inside = 0 <= target_px.x < w and 0 <= target_px.y < h

    annotated = crop.copy()
    r = max(5, int(w * 0.02))
    cv2.circle(annotated, (int(round(ball_px.x)), int(round(ball_px.y))), r + 3, (255, 255, 255), 2)
    cv2.circle(annotated, (int(round(pin_px.x)), int(round(pin_px.y))), r + 3, (255, 255, 255), 2)
    if inside:
        tx, ty = int(round(target_px.x)), int(round(target_px.y))
        cv2.line(annotated, (int(ball_px.x), int(ball_px.y)), (tx, ty), (0, 215, 255), 2)
        cv2.circle(annotated, (tx, ty), r + 6, (0, 215, 255), 3)
        cv2.drawMarker(annotated, (tx, ty), (0, 215, 255), cv2.MARKER_CROSS, 2 * r + 10, 2)

    return {
        "status": "ready" if inside else "target-off-map",
        "click": {"windowX": round(x0 + target_px.x, 1), "windowY": round(y0 + target_px.y, 1)} if inside else None,
        "minimap": {
            "ball": [round(ball_px.x, 1), round(ball_px.y, 1)],
            "pin": [round(pin_px.x, 1), round(pin_px.y, 1)],
            "target": [round(target_px.x, 1), round(target_px.y, 1)],
            "width": w, "height": h,
            "side": side, "roi": list(used_roi),
        },
        "checks": {
            "ballPinPixels": round(separation, 1),
            "ballPinVerticalAlignment": round(alignment, 3),
            "alignedLikeGspro": alignment <= MAX_ALIGNMENT_RATIO,
            # "free": the dots were found by colour and shape anywhere on the map (zoomed
            # green, angled par 3). Trusted only at a zoom GSPro actually uses.
            "pairing": pairing,
            "pairTrusted": alignment <= MAX_ALIGNMENT_RATIO or (
                pairing == "free"
                and FREE_PAIR_YARDS_PER_PIXEL[0] <= frame.yards_per_pixel <= FREE_PAIR_YARDS_PER_PIXEL[1]),
            "yardsPerPixel": round(frame.yards_per_pixel, 3),
        },
        "previewPng": _png_base64(annotated),
    }
