FW_ROWS = ["Bentgrass", "Bermuda", "Links"]
FIRM = ["Soft", "Medium", "Firm"]
CHIPS = [("Bump", "12° launch"), ("Chip", "20° launch"), ("Pitch", "28° launch"), ("Flop", "40° launch")]


def fw(title, sub, pill, vals):
    return {"kind": "grid", "title": title, "sub": sub, "pill": pill, "cols": FIRM, "base": (1, 0),
            "rows": list(zip(FW_ROWS, [vals[0:3], vals[3:6], vals[6:9]]))}


def gr(title, sub, pill, vals):
    return {"kind": "grid", "title": title, "sub": sub, "pill": pill, "cols": FIRM, "base": (1, 0),
            "rows": list(zip(FW_ROWS, vals))}


CARDS = [
    {
        "id": "fairways",
        "title": "How far does the ball [roll] on each fairway?",
        "lede": "Yards the ball rolls after it lands, for all nine GSPro fairway settings. The small number is the change from "
                "<b>Bermuda soft</b>, where GSPro’s range starts. Carry doesn’t change; only the roll does.",
        "panels": [
            fw("Driver", "231 yd", "2,800 rpm", [4.9, 9.2, 17.2, 13.6, 19.8, 27.6, 23.4, 29.6, 35.8]),
            fw("3 hybrid", "197 yd", "4,700 rpm", [3.6, 6.4, 11.9, 11.0, 15.9, 22.0, 19.9, 23.8, 28.5]),
            fw("7 iron", "158 yd", "6,200 rpm", [2.8, 3.1, 3.8, 6.5, 9.9, 14.7, 13.4, 16.5, 20.4]),
            fw("Pitching wedge", "121 yd", "8,600 rpm", [1.8, 1.9, 2.0, 3.7, 5.5, 8.2, 7.4, 9.8, 13.0]),
        ],
        "takeaways": [
            ("Set your range to the course.", "It starts on Bermuda soft; firm Links rolls a drive 22 yd further."),
            ("Grass beats firmness.", "Bentgrass to Links adds 20 yd to a drive; soft to firm on Bermuda, 14."),
            ("Bentgrass stops irons.", "A 7 iron rolls about 3 yd whatever the firmness."),
            ("Not a flat percentage.", "Firm Links gives a drive 2.6 times the roll, a wedge 3.5 times."),
        ],
        "footer": "Measured in GSPro 4.1.9, November 2026: each club’s stock shot onto the range at all nine settings, "
                  "checked against course fairways. Level ground, no wind. Launch numbers are typical for each club; yours will differ.",
    },
    {
        "id": "lies",
        "title": "What each [lie] takes off the ball",
        "lede": "GSPro cuts ball speed and spin, and not by a flat percentage. It moves a little from shot to shot, and in deep "
                "rough it depends on the launch: the lower the ball comes off, the more the grass grabs it.",
        "panels": [
            {"kind": "ranges", "title": "What\u2019s left", "sub": "of ball speed and spin, every shot measured", "span": "wide",
             "cols": ["Ball speed", "Spin"], "scale": (45, 100), "ticks": [50, 60, 70, 80, 90, 100],
             "rows": [("First cut", [(99, 99, 99, 99, 99), (95, 95, 95, 95, 95)]),
                      ("Rough", [(91, 93, 94, 96, 98), (60, 68, 77, 81, 81)]),
                      ("Sand", [(76, 88, 93, 93, 93), (77, 90, 100, 100, 100)]),
                      ("Deep rough", [(62, 71, 79, 81, 81), (49, 49, 53, 56, 56)]),
                      ("Cart path", [(75, 100, 100, 100, 100), (100, 100, 100, 100, 100)])],
             "foot": "Dot: the typical shot. Bar: most shots. Line: the full range. It moves with the shot: deep rough with the launch angle, "
                     "sand with how hard you swing (greenside bunkers keep about 76%); a driver-type shot off the cart path loses about a quarter."},
            {"kind": "bars", "title": "Deep rough", "sub": "ball speed kept, by launch", "max": 100,
             "rows": [("9\u00b0 launch", 64, "64%"), ("12\u00b0", 71, "71%"), ("14\u00b0", 72, "69\u201374%"),
                      ("19\u00b0", 77, "77%"), ("24\u00b0", 79, "79%"), ("30\u00b0", 81, "81%")]},
            {"kind": "bars", "title": "Out of deep rough", "sub": "carry vs clean", "max": 200,
             "rows": [("3 hybrid", 70, "70 / 200", 200), ("5 iron", 80, "80 / 179", 179), ("7 iron", 93, "93 / 159", 159),
                      ("PW", 82, "82 / 122", 122), ("SW", 66, "66 / 96", 96)],
             "foot": "Typical carries from shots across many deep rough lies."},
        ],
        "takeaways": [
            ("Deep rough is a launch problem.", "The lower it launches, the more speed the grass takes."),
            ("Take less club, not more.", "A 7 iron carried 93 out of deep rough; a 3 hybrid 70."),
            ("Rough is a flyer.", "It keeps the speed, takes a quarter of the spin, and the ball runs."),
            ("Sand and first cut barely count.", "Sand takes 7% of a full swing’s speed; the first cut about 1%."),
        ],
        "footer": "Measured in GSPro 4.1.9, November 2026, from shots fired out of each lie on four courses. Speed and spin kept "
                  "are GSPro’s own penalty numbers. Launch numbers are typical for each club; yours will differ.",
    },
    {
        "id": "slopes",
        "title": "Where a [sloped] lie sends the ball",
        "lede": "On a slope GSPro changes the launch, not your swing. Up or down the slope moves the launch angle; across it moves "
                "the start line, toward the side GSPro’s lie readout names. Lower-launching clubs feel it most.",
        "panels": [
            {"kind": "grid", "title": "Yards offline", "sub": "at the club’s normal carry, by side slope", "span": "wide",
             "cols": ["2°", "4°", "6°", "8°"], "diff": False,
             "rows": [(("3 hybrid", "196 yd"), [6.5, 12.9, 19.5, 26.0]), (("5 iron", "177 yd"), [5.4, 10.7, 16.1, 21.5]),
                      (("7 iron", "158 yd"), [4.2, 8.4, 12.6, 16.8]), (("Pitching wedge", "120 yd"), [2.6, 5.2, 7.8, 10.4]),
                      (("Sand wedge", "89 yd"), [1.6, 3.2, 4.8, 6.4])]},
            {"kind": "bars", "title": "Side slope", "sub": "share that becomes start line", "max": 100,
             "rows": [("3 hybrid", 94, "94%"), ("5 iron", 87, "87%"), ("7 iron", 76, "76%"), ("Pitching wedge", 62, "62%"), ("Sand wedge", 52, "52%")]},
            {"kind": "bars", "title": "Up or down", "sub": "share that becomes launch", "max": 100,
             "rows": [("3 hybrid", 71, "71%"), ("5 iron", 66, "66%"), ("7 iron", 60, "60%"), ("Pitching wedge", 52, "52%"), ("Sand wedge", 46, "46%")]},
        ],
        "takeaways": [
            ("Side slope costs the most.", "About 3 yd offline per degree with a hybrid, 2 with a 7 iron, 1 with a wedge."),
            ("Low launch feels it most.", "The opposite of real golf, where loft turns the face further."),
            ("Up and down barely move irons.", "A few yards of carry at most."),
            ("Hybrids hate downslopes.", "4° down cost a 3 hybrid 7 yd of carry; 8° cost 26."),
        ],
        "footer": "Measured in GSPro 4.1.9, November 2026: launch angle and start line from shots fired off sloped lies on several "
                  "courses, against GSPro’s lie readout. Yards worked out from those for each club’s normal shot. Launch numbers are typical; yours will differ.",
    },
    {
        "id": "approaches",
        "title": "How far does an approach [release] on each green?",
        "lede": "Yards the ball runs after it lands on the green, for all nine GSPro green settings at <b>stimp 11</b>. The small "
                "number is the change from <b>Bermuda soft</b>. Negative means it spins back.",
        "panels": [
            gr("Wedge", "100 yd", "9,800 rpm", [[-0.5, 0.0, 0.2], [0.0, 0.1, 0.1], [1.2, 1.7, 1.8]]),
            gr("9 iron", "135 yd", "8,600 rpm", [[-0.4, 0.0, 0.7], [0.3, 0.8, 1.2], [2.6, 3.9, 4.7]]),
            gr("7 iron", "160 yd", "7,000 rpm", [[0.0, 0.5, 2.3], [1.7, 3.4, 4.8], [5.8, 8.4, 10.4]]),
            gr("5 iron", "185 yd", "5,400 rpm", [[0.6, 2.9, 6.2], [5.9, 9.1, 11.9], [12.1, 16.1, 19.4]]),
        ],
        "takeaways": [
            ("Wedges barely care.", "Only Links moves them, by under 2 yd."),
            ("Bentgrass firm plays like Bermuda soft.", "Within half a yard for every club."),
            ("The gap grows with the club.", "Links firm adds 2 yd to a wedge, 13 to a 5 iron."),
            ("Stimp barely matters here.", "Stimp 8 to 13 moved a full wedge a tenth of a yard."),
        ],
        "footer": "Measured in GSPro 4.1.9, November 2026, on level greens, with stimp checked at 8, 11 and 13. Launch numbers "
                  "are typical for each club; yours will differ.",
    },
    {
        "id": "chipping",
        "title": "How far a [chip] runs, by where it lands",
        "lede": "Yards a chip runs after it lands. Every chip here carried 5 or 6 yards. The small number is the change from the "
                "setting in the cream box.",
        "panels": [
            {"kind": "grid", "title": "On the green", "sub": "by grass, stimp 11", "cols": ["Bentgrass", "Bermuda", "Links"], "base_col": 1,
             "rows": list(zip(CHIPS, [[14.0, 14.0, 18.3], [8.1, 8.7, 10.8], [5.9, 6.5, 8.4], [2.9, 3.3, 4.5]]))},
            {"kind": "grid", "title": "On the green", "sub": "by stimp, Bermuda", "cols": ["Stimp 8", "Stimp 11", "Stimp 13"], "base_col": 1,
             "rows": list(zip(CHIPS, [[11.3, 14.0, 16.4], [6.9, 8.7, 9.6], [5.0, 6.5, 7.3], [2.6, 3.3, 3.8]]))},
            {"kind": "grid", "title": "Short, in the fairway", "sub": "by firmness, Bermuda", "cols": FIRM, "base_col": 1,
             "rows": list(zip(CHIPS, [[10.0, 12.6, 15.2], [6.6, 7.9, 9.7], [4.3, 5.4, 6.4], [3.0, 4.0, 4.8]]))},
            {"kind": "grid", "title": "Short, in the fairway", "sub": "by grass, medium", "cols": ["Bentgrass", "Bermuda", "Links"], "base_col": 1,
             "rows": list(zip(CHIPS, [["18.6*", 12.6, 16.6], [8.1, 7.9, 12.2], [5.3, 5.4, 8.4], [3.4, 4.0, 5.9]])),
             "foot": "* One harder first bounce; otherwise Bentgrass runs a little less than Bermuda."},
        ],
        "takeaways": [
            ("The fairway decides.", "Landing short, firm or Links adds about half again."),
            ("Stimp hits chips hard.", "8 to 13 adds about 45% on the green."),
            ("Green firmness matters less.", "Soft to firm adds a fifth to a quarter."),
            ("Rough barely matters.", "It takes a third of the spin; the chip runs 5 to 10% further."),
        ],
        "footer": "Measured in GSPro 4.1.9, November 2026, at Briarwood West, with typical short-game launch and spin. Green "
                  "landings on a gentle upslope. If your launch monitor reads less spin on chips, they will run further.",
    },
    {
        "id": "putting",
        "title": "How far a [putt] rolls: only stimp and slope",
        "lede": "Feet a putt rolls in GSPro. Grass type and green firmness don’t change it at all. The small number is the "
                "change from the putt in the cream box.",
        "panels": [
            {"kind": "grid", "title": "Same stroke", "sub": "flat, by stimp", "cols": ["Stimp 8", "Stimp 11", "Stimp 13"], "base_col": 1,
             "rows": [("10 ft putt", [7.2, 10.0, 11.9]), ("20 ft putt", [15.1, 20.0, 23.2]), ("40 ft putt", [31.6, 40.0, 45.1])]},
            {"kind": "grid", "title": "Same stroke", "sub": "a 10 ft putt on a slope", "cols": ["Up 2%", "Flat", "Down 2%", "Down 3%"], "base_col": 1,
             "rows": [("Stimp 11", [7.8, 10.0, 13.9, 17.4]), ("Stimp 13", [7.4, 10.0, 15.4, 21.8])]},
            {"kind": "bars", "title": "Where a putt can’t stop", "sub": "downhill steeper than", "max": 8,
             "rows": [("Stimp 8", 7.5, "7.5%"), ("Stimp 9", 6.3, "6.3%"), ("Stimp 10", 5.4, "5.4%"), ("Stimp 11", 4.7, "4.7%"),
                      ("Stimp 12", 4.1, "4.1%"), ("Stimp 13", 3.6, "3.6%")]},
            {"kind": "tiles", "title": "Three things that surprised me",
             "tiles": [("0.00 ft", "Difference between five grass and firmness settings, same putt."),
                       ("11.0 ft", "A stimpmeter roll at GSPro stimp 11. The number is honest."),
                       ("68%", "Of real gravity: what GSPro applies along a slope.")]},
        ],
        "takeaways": [
            ("Grass and firmness do nothing.", "Once the ball rolls, only stimp and slope matter."),
            ("Stimp is worth feet, not inches.", "A 20 ft putt at stimp 11 rolls 15 at 8 and 23 at 13."),
            ("Slopes count about two-thirds.", "Down 2% turns a 10 ft putt into 14."),
            ("Fast and downhill can’t stop.", "Past 3.6% at stimp 13 the ball runs until the green flattens."),
        ],
        "footer": "Measured in GSPro 4.1.9, November 2026: putts from 2 to 8 mph on four practice greens, stimp 8 to 13, flat and "
                  "on slopes. One formula fits every putt that stopped to within 0.05 ft on average; the numbers here come from it.",
    },
]
