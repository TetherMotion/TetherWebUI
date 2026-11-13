// atc_tempctrl.st — Atc_TempCtrl: advanced temperature control library.
// Pure-ST, no services or hardware: every block takes CycleTime (s) and
// is deterministic per scan. Package as a `kind="library"` .tplc and
// consume into a program with `tplcc build prog.st --lib atc.tplc`.
//
//   tplcc build --library --name Atc_TempCtrl \
//       libraries/tempctrl/atc_tempctrl.st -o atc_tempctrl.tplc
//
// Layers:
//   math      F_AtcExp F_AtcLn F_AtcSqrt F_AtcPow   (fixed-iteration
//             LREAL — no libm in generated code)
//   signal    FB_AtcPt1 FB_AtcRateLim FB_AtcPwm FB_AtcHeatCool
//   classic   FB_AtcPid FB_AtcCascadePid FB_AtcSmith
//   state     FB_AtcLqr FB_AtcLqg FB_AtcModel2s
//   solvers   FB_AtcDare3 (3x3 DARE, Kleinman + Lyapunov squaring)
//             FB_AtcLqrTune (servo LQR) FB_AtcKalmanTune (Kalman L)
//   autotune  FB_AtcRelayTune (Astrom relay -> Ku/Tu -> PID rules)
//             FB_AtcStepIdent (open-loop step -> FOPDT K/Tau/Theta)
//             FB_AtcTuneRules (IMC/SIMC/ZN/CC/AMIGO from FOPDT)
//   profile   ST_AtcSeg + FB_AtcProfile (ramp/dwell/step/loop/end,
//             guaranteed soak, PV-start, per-segment event word)
//
// Conventions: all temperatures and outputs are LREAL; Out in % unless
// noted. FB inputs not bound in a call keep their last value (normal
// IEC semantics) — inputs with documented defaults are initialized so.
// FB_AtcProfile segment arrays cannot be call-bound (aggregate); write
// SEG[i].FIELD member-wise before invoking the block.
// Anti-windup: PID-family blocks back-calculate the integrator on
// saturation so the output leaves the limit as soon as the error
// reverses; HoldI freezes integration (cascade inner-limit coupling).

// ============================ math ============================

// F_AtcExp — e^x, range-reduced by ln2 + 10th-order Taylor on
// [-ln2/2, ln2/2] then exact 2^k scaling. |x| clamped to +/-700.
FUNCTION F_AtcExp : LREAL
VAR_INPUT
    X : LREAL;
END_VAR
VAR
    k : DINT;
    i : DINT;
    r : LREAL;
    t : LREAL;
    s : LREAL;
    xc : LREAL;
END_VAR
    xc := X;
    IF xc > 700.0 THEN xc := 700.0; END_IF;
    IF xc < -700.0 THEN xc := -700.0; END_IF;
    k := ROUND(xc / 0.6931471805599453);
    r := xc - DINT_TO_LREAL(k) * 0.6931471805599453;
    // Taylor sum_{n=0}^{10} r^n/n! — Horner form
    t := 1.0;
    s := 1.0;
    FOR i := 1 TO 10 DO
        t := t * r / DINT_TO_LREAL(i);
        s := s + t;
    END_FOR;
    // scale by 2^k (|k| <= 1011 for |x|<=700)
    IF k > 0 THEN
        FOR i := 1 TO k DO s := s * 2.0; END_FOR;
    ELSIF k < 0 THEN
        FOR i := 1 TO -k DO s := s * 0.5; END_FOR;
    END_IF;
    F_AtcExp := s;
END_FUNCTION

// F_AtcLn — ln(x), x>0. Reduces x = m*2^k with m in [1,2), then the
// atanh series ln m = 2*(t + t^3/3 + t^5/5 + ...), t=(m-1)/(m+1),
// 12 terms. x<=0 returns -1.0e300 (callers must guard).
FUNCTION F_AtcLn : LREAL
VAR_INPUT
    X : LREAL;
END_VAR
VAR
    m : LREAL;
    t : LREAL;
    t2 : LREAL;
    tp : LREAL;
    s : LREAL;
    k : DINT;
    i : DINT;
END_VAR
    IF X <= 0.0 THEN
        F_AtcLn := -1.0e300;
        RETURN;
    END_IF;
    m := X;
    k := 0;
    WHILE m >= 2.0 DO
        m := m * 0.5;
        k := k + 1;
    END_WHILE;
    WHILE m < 1.0 DO
        m := m * 2.0;
        k := k - 1;
    END_WHILE;
    t := (m - 1.0) / (m + 1.0);
    t2 := t * t;
    tp := t;
    s := 0.0;
    FOR i := 0 TO 11 DO
        s := s + tp / DINT_TO_LREAL(2 * i + 1);
        tp := tp * t2;
    END_FOR;
    F_AtcLn := 2.0 * s + DINT_TO_LREAL(k) * 0.6931471805599453;
END_FUNCTION

// F_AtcSqrt — Newton on the normalized range [0.25,4) (9 iterations),
// exact 4^k scaling. x<=0 returns 0.
FUNCTION F_AtcSqrt : LREAL
VAR_INPUT
    X : LREAL;
END_VAR
VAR
    m : LREAL;
    s : LREAL;
    k : DINT;
    i : DINT;
END_VAR
    IF X <= 0.0 THEN
        F_AtcSqrt := 0.0;
        RETURN;
    END_IF;
    m := X;
    k := 0;
    WHILE m >= 4.0 DO
        m := m * 0.25;
        k := k + 1;
    END_WHILE;
    WHILE m < 0.25 DO
        m := m * 4.0;
        k := k - 1;
    END_WHILE;
    s := 0.5 * (1.0 + m);
    i := 9;
    WHILE i > 0 DO
        s := 0.5 * (s + m / s);
        i := i - 1;
    END_WHILE;
    WHILE k > 0 DO
        s := s * 2.0;
        k := k - 1;
    END_WHILE;
    WHILE k < 0 DO
        s := s * 0.5;
        k := k + 1;
    END_WHILE;
    F_AtcSqrt := s;
END_FUNCTION

// F_AtcPow — B^E. B>0: exp(E*ln B). B=0: 0. B<0: defined only for
// integral |E| <= 64 (returns sign-adjusted product, else 0).
FUNCTION F_AtcPow : LREAL
VAR_INPUT
    B : LREAL;
    E : LREAL;
END_VAR
VAR
    i : DINT;
    n : DINT;
    s : LREAL;
END_VAR
    IF B > 0.0 THEN
        F_AtcPow := F_AtcExp(E * F_AtcLn(B));
        RETURN;
    END_IF;
    IF B = 0.0 THEN
        F_AtcPow := 0.0;
        RETURN;
    END_IF;
    IF E <> DINT_TO_LREAL(TRUNC(E)) OR E > 64.0 OR E < -64.0 THEN
        F_AtcPow := 0.0;
        RETURN;
    END_IF;
    n := TRUNC(E);
    s := 1.0;
    IF n >= 0 THEN
        i := n;
        WHILE i > 0 DO
            s := s * (-B);
            i := i - 1;
        END_WHILE;
    ELSE
        i := -n;
        WHILE i > 0 DO
            s := s / (-B);
            i := i - 1;
        END_WHILE;
    END_IF;
    F_AtcPow := s;
END_FUNCTION

// ============================ signal ============================

// FB_AtcPt1 — first-order lag filter (sensor smoothing).
//   Out <- Out + (In - Out) * Ts/(Tf + Ts); Tf=0 passes through.
FUNCTION_BLOCK FB_AtcPt1
VAR_INPUT
    Execute : BOOL;
    In : LREAL;
    Tf : LREAL;            // filter time constant (s); 0 = bypass
    CycleTime : LREAL;
    Reset : BOOL;          // Reset -> Out := In
END_VAR
VAR_OUTPUT
    Done : BOOL;
    Out : LREAL;
END_VAR
    Done := FALSE;
    IF Reset THEN
        Out := In;
    END_IF;
    IF Execute AND CycleTime > 0.0 THEN
        IF Tf > 0.0 THEN
            Out := Out + (In - Out) * (CycleTime / (Tf + CycleTime));
        ELSE
            Out := In;
        END_IF;
        Done := TRUE;
    END_IF;
END_FUNCTION_BLOCK

// FB_AtcRateLim — slew-rate limiter: Out approaches In at |Rate|
// units/s (Rate<=0 = bypass).
FUNCTION_BLOCK FB_AtcRateLim
VAR_INPUT
    Execute : BOOL;
    In : LREAL;
    Rate : LREAL;          // max |dOut/dt| (units/s); 0 = bypass
    CycleTime : LREAL;
    Reset : BOOL;          // Reset -> Out := In
END_VAR
VAR_OUTPUT
    Done : BOOL;
    Out : LREAL;
END_VAR
VAR
    d : LREAL;
    m : LREAL;
END_VAR
    Done := FALSE;
    IF Reset THEN
        Out := In;
    END_IF;
    IF Execute AND CycleTime > 0.0 THEN
        IF Rate > 0.0 THEN
            d := In - Out;
            m := Rate * CycleTime;
            IF d > m THEN d := m; END_IF;
            IF d < -m THEN d := -m; END_IF;
            Out := Out + d;
        ELSE
            Out := In;
        END_IF;
        Done := TRUE;
    END_IF;
END_FUNCTION_BLOCK

// FB_AtcPwm — time-proportioning output: duty % -> BOOL pulse of
// period Period (s). MinOn clamps very short pulses to 0.
FUNCTION_BLOCK FB_AtcPwm
VAR_INPUT
    Execute : BOOL;
    Duty : LREAL;          // 0..100 %
    Period : LREAL;        // PWM period (s) > 0
    MinOn : LREAL;         // min on-time (s); pulses shorter -> off
    CycleTime : LREAL;
    Reset : BOOL;
END_VAR
VAR_OUTPUT
    Done : BOOL;
    Q : BOOL;
    Ton : LREAL;           // on-time this period (s)
END_VAR
VAR
    t : LREAL;
    d : LREAL;
END_VAR
    Done := FALSE;
    IF Reset THEN
        t := 0.0;
        Q := FALSE;
    END_IF;
    IF Execute AND CycleTime > 0.0 AND Period > 0.0 THEN
        d := Duty;
        IF d < 0.0 THEN d := 0.0; END_IF;
        IF d > 100.0 THEN d := 100.0; END_IF;
        t := t + CycleTime;
        IF t >= Period THEN t := t - Period; END_IF;
        Ton := Period * d / 100.0;
        IF Ton < MinOn THEN
            Q := FALSE;
        ELSE
            Q := t < Ton;
        END_IF;
        Done := TRUE;
    END_IF;
END_FUNCTION_BLOCK

// FB_AtcHeatCool — split-range: U in [-100,100] -> Heat% = max(U,0),
// Cool% = max(-U,0)*CoolGain, with symmetric dead zone |U| < DeadZone.
FUNCTION_BLOCK FB_AtcHeatCool
VAR_INPUT
    Execute : BOOL;
    U : LREAL;             // -100..100
    DeadZone : LREAL;      // |U| below this -> both outputs 0
    CoolGain : LREAL;      // cool channel scaling (default 1.0)
END_VAR
VAR_OUTPUT
    Done : BOOL;
    Heat : LREAL;          // 0..100
    Cool : LREAL;          // 0..100
END_VAR
VAR
    dz : LREAL;
    cg : LREAL;
    uc : LREAL;
END_VAR
    Done := FALSE;
    IF Execute THEN
        dz := DeadZone;
        IF dz < 0.0 THEN dz := 0.0; END_IF;
        cg := CoolGain;
        IF cg <= 0.0 THEN cg := 1.0; END_IF;
        uc := U;
        IF uc > 100.0 THEN uc := 100.0; END_IF;
        IF uc < -100.0 THEN uc := -100.0; END_IF;
        IF uc > dz THEN
            Heat := uc - dz;
            Cool := 0.0;
        ELSIF uc < -dz THEN
            Heat := 0.0;
            Cool := (-uc - dz) * cg;
            IF Cool > 100.0 THEN Cool := 100.0; END_IF;
        ELSE
            Heat := 0.0;
            Cool := 0.0;
        END_IF;
        Done := TRUE;
    END_IF;
END_FUNCTION_BLOCK

// ============================ classic ============================

// FB_AtcPid — positional PID with setpoint weighting, filtered
// derivative on measurement, back-calculation anti-windup, output
// slew limit, deadband, tracking and manual modes.
//
//   e    = SP - PV (through Deadband)
//   u    = Kp*(B*SP - PV) + iTerm + dF + FFwd
//   iTerm'= iTerm + Kp*e*Ts/Tn           (Tn<=0 or HoldI -> frozen)
//   dF   = PT1-filtered Kp*Tv/Ts * (C*SP - PV - prev)
// On output clamp or slew clip the integrator is back-calculated so
// u == uSat. TrackEn forces u = TrackVal; ManEn forces u = ManOut —
// both with bumpless return (integrator is preloaded every scan).
FUNCTION_BLOCK FB_AtcPid
VAR_INPUT
    Execute : BOOL;
    Setpoint : LREAL;
    Actual : LREAL;
    Kp : LREAL;
    Tn : LREAL;            // integral time (s); 0 = no I
    Tv : LREAL;            // derivative time (s); 0 = no D
    TfD : LREAL;           // D filter time (s); 0 -> Tv/10
    B : LREAL;             // SP weight on P (0..1; init 1.0)
    C : LREAL;             // SP weight on D (usually 0)
    FFwd : LREAL;          // feedforward added to u
    OutMin : LREAL;
    OutMax : LREAL;
    RateLim : LREAL;       // max |du/dt| (out/s); 0 = off
    Deadband : LREAL;      // |er| below this counts as 0
    HoldI : BOOL;          // freeze integration (cascade inner limit)
    TrackEn : BOOL;        // force u = TrackVal (bumpless)
    TrackVal : LREAL;
    ManEn : BOOL;          // manual mode: u = ManOut
    ManOut : LREAL;
    CycleTime : LREAL;
    Reset : BOOL;
    InitB : BOOL;          // set TRUE once to re-apply B/C defaults
END_VAR
VAR_OUTPUT
    Done : BOOL;
    Out : LREAL;
    E : LREAL;
    PTerm : LREAL;
    ITerm : LREAL;
    DTerm : LREAL;
    AtLimit : BOOL;        // output sat at a bound or slew-limited
    Err : BOOL;
    ErrId : INT;           // 1: CycleTime<=0  2: OutMin>=OutMax
END_VAR
VAR
    iAcc : LREAL;   // integrator accumulator (mirrored to ITerm)
    df : LREAL;
    prevMd : LREAL;
    prevOut : LREAL;
    init : BOOL;
    er : LREAL;
    p : LREAL;
    draw : LREAL;
    md : LREAL;
    tfW : LREAL;
    u : LREAL;
    uu : LREAL;
    m : LREAL;
    bw : LREAL;
    cw : LREAL;
END_VAR
    Done := FALSE;
    Err := FALSE;
    ErrId := 0;
    IF Reset THEN
        iAcc := 0.0;
        df := 0.0;
        prevMd := 0.0;
        prevOut := 0.0;
        init := FALSE;
    END_IF;
    // defaults applied on first run (or InitB): B=1, C=0
    IF NOT init OR InitB THEN
        IF B = 0.0 AND C = 0.0 THEN B := 1.0; END_IF;
        prevMd := C * Setpoint - Actual;
        prevOut := Out;
        init := TRUE;
    END_IF;
    IF Execute THEN
        IF CycleTime <= 0.0 THEN
            Err := TRUE; ErrId := 1;
        ELSIF OutMin >= OutMax THEN
            Err := TRUE; ErrId := 2;
        ELSE
            er := Setpoint - Actual;
            IF er > -Deadband AND er < Deadband THEN er := 0.0; END_IF;
            bw := B; cw := C;
            IF bw < 0.0 THEN bw := 0.0; END_IF;
            IF bw > 1.0 THEN bw := 1.0; END_IF;
            IF cw < 0.0 THEN cw := 0.0; END_IF;
            IF cw > 1.0 THEN cw := 1.0; END_IF;
            p := Kp * (bw * Setpoint - Actual);
            // derivative on (cw*SP - PV), PT1-filtered
            md := cw * Setpoint - Actual;
            IF Tv > 0.0 THEN
                tfW := TfD;
                IF tfW <= 0.0 THEN tfW := Tv * 0.1; END_IF;
                draw := Kp * Tv * (md - prevMd) / CycleTime;
                df := df + (draw - df) *
                            (CycleTime / (tfW + CycleTime));
            ELSE
                df := 0.0;
            END_IF;
            prevMd := md;
            // integrator (contribution form: holds Kp*int_e/Tn)
            IF Tn > 0.0 AND NOT HoldI THEN
                iAcc := iAcc + Kp * er * CycleTime / Tn;
            END_IF;
            u := p + iAcc + df + FFwd;
            IF TrackEn THEN
                u := TrackVal;
                iAcc := u - p - df - FFwd;
            ELSIF ManEn THEN
                u := ManOut;
                iAcc := u - p - df - FFwd;
            ELSE
                // clamp + back-calculate anti-reset windup
                uu := u;
                IF u > OutMax THEN u := OutMax; END_IF;
                IF u < OutMin THEN u := OutMin; END_IF;
                AtLimit := u <> uu;
                IF uu <> u THEN
                    iAcc := iAcc - (uu - u);
                END_IF;
                // slew limit (+ back-calc on the clipped amount)
                IF RateLim > 0.0 THEN
                    m := RateLim * CycleTime;
                    uu := u;
                    IF u - prevOut > m THEN u := prevOut + m; END_IF;
                    IF u - prevOut < -m THEN u := prevOut - m; END_IF;
                    IF uu <> u THEN
                        iAcc := iAcc - (uu - u);
                        AtLimit := TRUE;
                    END_IF;
                END_IF;
            END_IF;
            prevOut := u;
            Out := u;
            E := Setpoint - Actual;
            PTerm := p;
            ITerm := iAcc;
            DTerm := df;
            Done := TRUE;
        END_IF;
    END_IF;
END_FUNCTION_BLOCK

// FB_AtcCascadePid — master/slave cascade: outer (process) loop
// produces the inner loop's setpoint; inner loop drives the actuator
// (e.g. outer = product temp, inner = heater temp, Out = heater %).
// The outer output is clamped to InnerSpMin/Max; while the inner loop
// sits at a limit the outer integrator is held via HoldI.
FUNCTION_BLOCK FB_AtcCascadePid
VAR_INPUT
    Execute : BOOL;
    Setpoint : LREAL;      // process (outer) target
    PvOuter : LREAL;       // process temperature
    PvInner : LREAL;       // heater/actuator temperature
    KpO : LREAL;
    TnO : LREAL;
    TvO : LREAL;
    KpI : LREAL;
    TnI : LREAL;
    TvI : LREAL;
    InnerSpMin : LREAL;    // clamp for outer-produced inner SP
    InnerSpMax : LREAL;
    OutMin : LREAL;        // inner (actuator) output limits
    OutMax : LREAL;
    ManEn : BOOL;
    ManOut : LREAL;
    CycleTime : LREAL;
    Reset : BOOL;
END_VAR
VAR_OUTPUT
    Done : BOOL;
    Out : LREAL;
    InnerSp : LREAL;
    E : LREAL;
END_VAR
VAR
    outer : FB_AtcPid;
    inner : FB_AtcPid;
    isp : LREAL;
END_VAR
    Done := FALSE;
    IF Reset THEN
        outer(Execute := FALSE, Reset := TRUE);
        inner(Execute := FALSE, Reset := TRUE);
        isp := PvInner;
    END_IF;
    IF Execute AND CycleTime > 0.0 THEN
        outer(Execute := TRUE, Reset := FALSE,
              Setpoint := Setpoint, Actual := PvOuter,
              Kp := KpO, Tn := TnO, Tv := TvO, TfD := 0.0,
              B := 1.0, C := 0.0, FFwd := 0.0,
              OutMin := InnerSpMin, OutMax := InnerSpMax,
              RateLim := 0.0, Deadband := 0.0,
              HoldI := inner.AtLimit,
              TrackEn := FALSE, TrackVal := 0.0,
              ManEn := FALSE, ManOut := 0.0,
              CycleTime := CycleTime);
        isp := outer.Out;
        IF isp < InnerSpMin THEN isp := InnerSpMin; END_IF;
        IF isp > InnerSpMax THEN isp := InnerSpMax; END_IF;
        inner(Execute := TRUE, Reset := FALSE,
              Setpoint := isp, Actual := PvInner,
              Kp := KpI, Tn := TnI, Tv := TvI, TfD := 0.0,
              B := 1.0, C := 0.0, FFwd := 0.0,
              OutMin := OutMin, OutMax := OutMax,
              RateLim := 0.0, Deadband := 0.0,
              HoldI := FALSE,
              TrackEn := FALSE, TrackVal := 0.0,
              ManEn := ManEn, ManOut := ManOut,
              CycleTime := CycleTime);
        Out := inner.Out;
        InnerSp := isp;
        E := outer.E;
        Done := TRUE;
    END_IF;
END_FUNCTION_BLOCK

// FB_AtcSmith — Smith predictor for dead-time-dominant loops.
// A first-order model (ModelK, ModelT) runs in parallel with the
// plant; the controller sees (SP - PV) + (xNoDelay - xDelayed), so
// the PID acts on the undelayed model correction. The internal
// FB_AtcPid provides all limiting/manual semantics.
// ModelDt is realized by a 128-deep ring of model states; the delay
// is rounded to whole scans, max 127*CycleTime.
FUNCTION_BLOCK FB_AtcSmith
VAR_INPUT
    Execute : BOOL;
    Setpoint : LREAL;
    Actual : LREAL;
    Kp : LREAL;
    Tn : LREAL;
    Tv : LREAL;
    ModelK : LREAL;        // process gain (pv per out-unit)
    ModelT : LREAL;        // process lag (s)
    ModelDt : LREAL;       // dead time (s)
    OutMin : LREAL;
    OutMax : LREAL;
    ManEn : BOOL;
    ManOut : LREAL;
    CycleTime : LREAL;
    Reset : BOOL;
END_VAR
VAR_OUTPUT
    Done : BOOL;
    Out : LREAL;
    E : LREAL;             // compensated error fed to the PID
    Err : BOOL;
END_VAR
VAR
    pid : FB_AtcPid;
    dl : ARRAY[0..127] OF LREAL;
    head : DINT;
    n : DINT;
    i : DINT;
    x1 : LREAL;
    xd : LREAL;
    speff : LREAL;
END_VAR
    Done := FALSE;
    Err := FALSE;
    IF Reset THEN
        pid(Execute := FALSE, Reset := TRUE);
        FOR i := 0 TO 127 DO dl[i] := 0.0; END_FOR;
        head := 0;
        x1 := 0.0;
    END_IF;
    IF Execute THEN
        IF CycleTime <= 0.0 OR ModelT <= 0.0 THEN
            Err := TRUE;
        ELSE
            // undelayed first-order model on the last output
            x1 := x1 + (ModelK * Out - x1) *
                       (CycleTime / (ModelT + CycleTime));
            // push into ring; delayed value is n slots back
            dl[head] := x1;
            n := TRUNC(ModelDt / CycleTime + 0.5);
            IF n < 0 THEN n := 0; END_IF;
            IF n > 127 THEN n := 127; END_IF;
            i := head - n;
            IF i < 0 THEN i := i + 128; END_IF;
            xd := dl[i];
            head := head + 1;
            IF head >= 128 THEN head := 0; END_IF;
            speff := Setpoint + (x1 - xd);
            pid(Execute := TRUE, Reset := FALSE,
                Setpoint := speff, Actual := Actual,
                Kp := Kp, Tn := Tn, Tv := Tv, TfD := 0.0,
                B := 1.0, C := 0.0, FFwd := 0.0,
                OutMin := OutMin, OutMax := OutMax,
                RateLim := 0.0, Deadband := 0.0,
                HoldI := FALSE,
                TrackEn := FALSE, TrackVal := 0.0,
                ManEn := ManEn, ManOut := ManOut,
                CycleTime := CycleTime);
            Out := pid.Out;
            E := speff - Actual;
            Done := TRUE;
        END_IF;
    END_IF;
END_FUNCTION_BLOCK

// ============================ state-space ============================

// FB_AtcLqr — discrete LQR servo: u = Nref*SP - K1*x1 - K2*x2
//             + Ki*xi + FFwd,   xi' = xi + (SP - PV)*Ts.
// x1 is the measured output (Actual); x2 is the second plant state —
// wire a measured heater temperature here, or the estimated state
// from FB_AtcLqg.X2. Gains come from FB_AtcLqrTune (or hand). On
// clamp the integral state is back-calculated. Sign convention: Ki
// is positive for a self-regulating heating process.
FUNCTION_BLOCK FB_AtcLqr
VAR_INPUT
    Execute : BOOL;
    Setpoint : LREAL;
    Actual : LREAL;        // x1: measured process temperature
    X2 : LREAL;            // second plant state (measured/estimated)
    K1 : LREAL;
    K2 : LREAL;
    Ki : LREAL;
    Nref : LREAL;          // setpoint precomp (usually small/0)
    FFwd : LREAL;
    OutMin : LREAL;
    OutMax : LREAL;
    RateLim : LREAL;
    ManEn : BOOL;
    ManOut : LREAL;
    CycleTime : LREAL;
    Reset : BOOL;
END_VAR
VAR_OUTPUT
    Done : BOOL;
    Out : LREAL;
    E : LREAL;
    Xi : LREAL;
    AtLimit : BOOL;
    Err : BOOL;
END_VAR
VAR
    prevOut : LREAL;
    u : LREAL;
    uu : LREAL;
    m : LREAL;
END_VAR
    Done := FALSE;
    Err := FALSE;
    IF Reset THEN
        Xi := 0.0;
        prevOut := 0.0;
    END_IF;
    IF Execute THEN
        IF CycleTime <= 0.0 THEN
            Err := TRUE;
        ELSE
            E := Setpoint - Actual;
            IF ManEn THEN
                u := ManOut;
                Xi := u - Nref * Setpoint + K1 * Actual +
                      K2 * X2 - FFwd;
                IF Ki <> 0.0 THEN Xi := Xi / Ki; END_IF;
            ELSE
                Xi := Xi + E * CycleTime;
                u := Nref * Setpoint - K1 * Actual - K2 * X2 +
                     Ki * Xi + FFwd;
                uu := u;
                IF u > OutMax THEN u := OutMax; END_IF;
                IF u < OutMin THEN u := OutMin; END_IF;
                AtLimit := u <> uu;
                IF uu <> u AND Ki <> 0.0 THEN
                    Xi := Xi - (uu - u) / Ki;
                END_IF;
                IF RateLim > 0.0 THEN
                    m := RateLim * CycleTime;
                    uu := u;
                    IF u - prevOut > m THEN u := prevOut + m; END_IF;
                    IF u - prevOut < -m THEN u := prevOut - m; END_IF;
                    IF uu <> u THEN
                        AtLimit := TRUE;
                        IF Ki <> 0.0 THEN Xi := Xi - (uu - u) / Ki; END_IF;
                    END_IF;
                END_IF;
            END_IF;
            prevOut := u;
            Out := u;
            Done := TRUE;
        END_IF;
    END_IF;
END_FUNCTION_BLOCK

// FB_AtcLqg — LQR law on Kalman-filtered state estimates.
// Plant model (discrete, from FB_AtcModel2s or hand):
//   x+ = A x + B u,   y = x1 (+noise)
// each scan: xp = A*xh + B*u_prev; innov = PV - xp1;
//            xh = xp + L*innov;  u = Nref*SP - K1*xh1 - K2*xh2 + Ki*xi.
// L1/L2 are the steady-state filter gains (FB_AtcKalmanTune);
// K1/K2/Ki the LQR gains (FB_AtcLqrTune).
FUNCTION_BLOCK FB_AtcLqg
VAR_INPUT
    Execute : BOOL;
    Setpoint : LREAL;
    Actual : LREAL;
    A11 : LREAL;
    A12 : LREAL;
    A21 : LREAL;
    A22 : LREAL;
    B1 : LREAL;
    B2 : LREAL;
    L1 : LREAL;            // Kalman gains
    L2 : LREAL;
    K1 : LREAL;            // LQR gains
    K2 : LREAL;
    Ki : LREAL;
    Nref : LREAL;
    FFwd : LREAL;
    OutMin : LREAL;
    OutMax : LREAL;
    ManEn : BOOL;
    ManOut : LREAL;
    CycleTime : LREAL;
    Reset : BOOL;
END_VAR
VAR_OUTPUT
    Done : BOOL;
    Out : LREAL;
    E : LREAL;
    X1 : LREAL;            // estimated states (x1 ~= filtered PV)
    X2 : LREAL;
    Xi : LREAL;
    AtLimit : BOOL;
    Err : BOOL;
END_VAR
VAR
    xh1 : LREAL;
    xh2 : LREAL;
    xp1 : LREAL;
    xp2 : LREAL;
    inno : LREAL;
    u : LREAL;
    uu : LREAL;
    first : BOOL;
END_VAR
    Done := FALSE;
    Err := FALSE;
    IF Reset THEN
        xh1 := 0.0;
        xh2 := 0.0;
        Xi := 0.0;
        first := TRUE;
    END_IF;
    IF Execute THEN
        IF CycleTime <= 0.0 THEN
            Err := TRUE;
        ELSE
            IF first THEN
                xh1 := Actual;
                first := FALSE;
            END_IF;
            // predict with last scan's output, then correct by PV
            xp1 := A11 * xh1 + A12 * xh2 + B1 * Out;
            xp2 := A21 * xh1 + A22 * xh2 + B2 * Out;
            inno := Actual - xp1;
            xh1 := xp1 + L1 * inno;
            xh2 := xp2 + L2 * inno;
            E := Setpoint - Actual;
            IF ManEn THEN
                u := ManOut;
                Xi := u - Nref * Setpoint + K1 * xh1 +
                      K2 * xh2 - FFwd;
                IF Ki <> 0.0 THEN Xi := Xi / Ki; END_IF;
            ELSE
                Xi := Xi + E * CycleTime;
                u := Nref * Setpoint - K1 * xh1 - K2 * xh2 +
                     Ki * Xi + FFwd;
                uu := u;
                IF u > OutMax THEN u := OutMax; END_IF;
                IF u < OutMin THEN u := OutMin; END_IF;
                AtLimit := u <> uu;
                IF uu <> u AND Ki <> 0.0 THEN
                    Xi := Xi - (uu - u) / Ki;
                END_IF;
            END_IF;
            Out := u;
            X1 := xh1;
            X2 := xh2;
            Done := TRUE;
        END_IF;
    END_IF;
END_FUNCTION_BLOCK

// FB_AtcModel2s — FOPDT process (K, Tau, Theta) -> discrete 2-state
// series-lag model used by FB_AtcLqrTune/FB_AtcKalmanTune/FB_AtcLqg:
//   heater/sensor lag TauH (+ dead time folded in) drives the main
//   process lag Tau:
//   A = [[a1, 1-a1],[0, a2]]   B = [[0],[K*(1-a2)]]   C = [1, 0]
//   a1 = exp(-Ts/Tau), a2 = exp(-Ts/(TauH + Theta))
// Dead time is approximated by slowing the first lag — accurate
// enough for Theta <~ Tau; for dead-time-dominant loops use
// FB_AtcSmith instead. Ts = control cycle (s).
FUNCTION_BLOCK FB_AtcModel2s
VAR_INPUT
    Execute : BOOL;
    K : LREAL;             // process gain (deg per out-unit)
    Tau : LREAL;           // main lag (s)
    Theta : LREAL;         // dead time (s)
    TauH : LREAL;          // heater/sensor lag (s); 0 -> 0.1*Tau
    Ts : LREAL;            // discretization step (s) = CycleTime
END_VAR
VAR_OUTPUT
    Done : BOOL;
    Err : BOOL;
    A11 : LREAL;
    A12 : LREAL;
    A21 : LREAL;
    A22 : LREAL;
    B1 : LREAL;
    B2 : LREAL;
END_VAR
VAR
    th : LREAL;
    t1 : LREAL;
    a1 : LREAL;
    a2 : LREAL;
END_VAR
    Done := FALSE;
    Err := FALSE;
    IF Execute THEN
        IF K = 0.0 OR Tau <= 0.0 OR Ts <= 0.0 THEN
            Err := TRUE;
        ELSE
            th := TauH;
            IF th <= 0.0 THEN th := 0.1 * Tau; END_IF;
            th := th + Theta;
            IF th < 0.001 * Ts THEN th := 0.001 * Ts; END_IF;
            t1 := Tau;
            IF t1 < 0.001 * Ts THEN t1 := 0.001 * Ts; END_IF;
            a1 := F_AtcExp(-Ts / t1);
            a2 := F_AtcExp(-Ts / th);
            A11 := a1;
            A12 := 1.0 - a1;
            A21 := 0.0;
            A22 := a2;
            B1 := 0.0;
            B2 := K * (1.0 - a2);
            Done := TRUE;
        END_IF;
    END_IF;
END_FUNCTION_BLOCK

// ============================ solvers ============================

// FB_AtcDare3 — internal 3x3 discrete algebraic Riccati solver.
//   P = A'PA - A'PB (R + B'PB)^-1 B'PA + Q,  K = (R+B'PB)^-1 B'PA
// Solved by Kleinman (Newton) iteration: each step solves the
// discrete Lyapunov equation (A-BK)'P(A-BK) - P = -(Q + K'RK) by
// matrix squaring (G <- G + W'GW; W <- W*W). Squaring converges in
// ~32 steps even for closed-loop poles arbitrarily close to 1, and
// Kleinman converges quadratically (~10 steps). Plain fixed-point
// iteration on P is not used: it converges linearly at the open-loop
// spectral radius and needs O(1e4) iterations for servo models whose
// integrator adds a pole at exactly 1. Deterministic: <= 60 outer
// steps x <= 40 squarings of 3x3 multiplies (~200 kflop worst case).
FUNCTION_BLOCK FB_AtcDare3
VAR_INPUT
    Execute : BOOL;
    A1 : LREAL; A2 : LREAL; A3 : LREAL;    // A row-major
    A4 : LREAL; A5 : LREAL; A6 : LREAL;
    A7 : LREAL; A8 : LREAL; A9 : LREAL;
    B1 : LREAL; B2 : LREAL; B3 : LREAL;
    Q11 : LREAL; Q12 : LREAL; Q13 : LREAL; // Q symmetric
    Q22 : LREAL; Q23 : LREAL; Q33 : LREAL;
    R : LREAL;             // > 0
    MaxIter : DINT;        // Kleinman steps; 0 -> 30
    LyapIter : DINT;       // squaring depth; 0 -> 32
    Tol : LREAL;           // 0 -> 1e-10 (gain change)
END_VAR
VAR_OUTPUT
    Done : BOOL;
    Err : BOOL;
    Conv : BOOL;
    K1 : LREAL;
    K2 : LREAL;
    K3 : LREAL;
    P1 : LREAL; P2 : LREAL; P3 : LREAL;    // P under final K
    P4 : LREAL; P5 : LREAL; P6 : LREAL;
    P7 : LREAL; P8 : LREAL; P9 : LREAL;
    Iter : DINT;
END_VAR
VAR
    last : BOOL;
    a : ARRAY[0..8] OF LREAL;
    b : ARRAY[0..2] OF LREAL;
    q : ARRAY[0..8] OF LREAL;
    ac : ARRAY[0..8] OF LREAL;
    g : ARRAY[0..8] OF LREAL;
    w : ARRAY[0..8] OF LREAL;
    t : ARRAY[0..8] OF LREAL;
    kg : ARRAY[0..2] OF LREAL;
    kn : ARRAY[0..2] OF LREAL;
    s : LREAL;
    mx : LREAL;
    kmx : LREAL;
    tlv : LREAL;
    wmx : LREAL;
    mi : DINT;
    lit : DINT;
    it : DINT;
    li : DINT;
    ri : DINT;
    cc : DINT;
    kk : DINT;
END_VAR
    IF Execute AND NOT last THEN
        Done := FALSE;
        Err := FALSE;
        Conv := FALSE;
        Iter := 0;
        IF R <= 0.0 THEN
            Err := TRUE;
        ELSE
            a[0] := A1; a[1] := A2; a[2] := A3;
            a[3] := A4; a[4] := A5; a[5] := A6;
            a[6] := A7; a[7] := A8; a[8] := A9;
            b[0] := B1; b[1] := B2; b[2] := B3;
            FOR ri := 0 TO 8 DO q[ri] := 0.0; END_FOR;
            q[0] := Q11; q[1] := Q12; q[2] := Q13;
            q[3] := Q12; q[4] := Q22; q[5] := Q23;
            q[6] := Q13; q[7] := Q23; q[8] := Q33;
            mi := MaxIter;
            IF mi <= 0 THEN mi := 30; END_IF;
            IF mi > 60 THEN mi := 60; END_IF;
            lit := LyapIter;
            IF lit <= 0 THEN lit := 32; END_IF;
            IF lit > 40 THEN lit := 40; END_IF;
            tlv := Tol;
            IF tlv <= 0.0 THEN tlv := 1.0e-10; END_IF;
            // seed gain kg = (R + B'QB)^-1 B'QA
            s := R;
            FOR ri := 0 TO 2 DO
                FOR cc := 0 TO 2 DO
                    s := s + b[ri] * q[ri * 3 + cc] * b[cc];
                END_FOR;
            END_FOR;
            IF s <= 0.0 THEN
                Err := TRUE;
            ELSE
                FOR cc := 0 TO 2 DO
                    kn[cc] := 0.0;
                    FOR ri := 0 TO 2 DO
                        FOR kk := 0 TO 2 DO
                            kn[cc] := kn[cc] + b[ri] *
                                      q[ri * 3 + kk] * a[kk * 3 + cc];
                        END_FOR;
                    END_FOR;
                    kg[cc] := kn[cc] / s;
                END_FOR;
                // Kleinman iterations
                FOR it := 1 TO mi DO
                    // Ac = A - B*kg ; G = Q + kg'R kg ; W = Ac
                    FOR ri := 0 TO 2 DO
                        FOR cc := 0 TO 2 DO
                            ac[ri * 3 + cc] := a[ri * 3 + cc] -
                                               b[ri] * kg[cc];
                            g[ri * 3 + cc] := q[ri * 3 + cc] +
                                              R * kg[ri] * kg[cc];
                            w[ri * 3 + cc] := ac[ri * 3 + cc];
                        END_FOR;
                    END_FOR;
                    // Lyapunov solve via squaring:
                    //   G += W'GW ; W = W*W  ->  G = sum W'^i M W^i
                    FOR li := 1 TO lit DO
                        FOR ri := 0 TO 2 DO
                            FOR cc := 0 TO 2 DO
                                s := 0.0;
                                FOR kk := 0 TO 2 DO
                                    s := s + g[ri * 3 + kk] *
                                         w[kk * 3 + cc];
                                END_FOR;
                                t[ri * 3 + cc] := s;
                            END_FOR;
                        END_FOR;
                        FOR ri := 0 TO 2 DO
                            FOR cc := 0 TO 2 DO
                                s := 0.0;
                                FOR kk := 0 TO 2 DO
                                    s := s + w[kk * 3 + ri] *
                                         t[kk * 3 + cc];
                                END_FOR;
                                g[ri * 3 + cc] := g[ri * 3 + cc] + s;
                            END_FOR;
                        END_FOR;
                        FOR ri := 0 TO 2 DO
                            FOR cc := 0 TO 2 DO
                                s := 0.0;
                                FOR kk := 0 TO 2 DO
                                    s := s + w[ri * 3 + kk] *
                                         w[kk * 3 + cc];
                                END_FOR;
                                t[ri * 3 + cc] := s;
                            END_FOR;
                        END_FOR;
                        wmx := 0.0;
                        FOR ri := 0 TO 8 DO
                            w[ri] := t[ri];
                            IF w[ri] < 0.0 THEN s := -w[ri];
                            ELSE s := w[ri]; END_IF;
                            IF s > wmx THEN wmx := s; END_IF;
                        END_FOR;
                        IF wmx < 1.0e-14 THEN li := lit; END_IF;
                    END_FOR;
                    // kn = (R + B'GB)^-1 B'GA
                    s := R;
                    FOR ri := 0 TO 2 DO
                        FOR cc := 0 TO 2 DO
                            s := s + b[ri] * g[ri * 3 + cc] * b[cc];
                        END_FOR;
                    END_FOR;
                    IF s <= 0.0 THEN
                        Err := TRUE;
                        it := mi;
                    ELSE
                        mx := 0.0;
                        kmx := 0.0;
                        FOR cc := 0 TO 2 DO
                            kn[cc] := 0.0;
                            FOR ri := 0 TO 2 DO
                                FOR kk := 0 TO 2 DO
                                    kn[cc] := kn[cc] + b[ri] *
                                        g[ri * 3 + kk] * a[kk * 3 + cc];
                                END_FOR;
                            END_FOR;
                            kn[cc] := kn[cc] / s;
                            IF kn[cc] - kg[cc] > mx THEN
                                mx := kn[cc] - kg[cc];
                            END_IF;
                            IF kg[cc] - kn[cc] > mx THEN
                                mx := kg[cc] - kn[cc];
                            END_IF;
                            IF kn[cc] > kmx THEN kmx := kn[cc]; END_IF;
                            IF -kn[cc] > kmx THEN kmx := -kn[cc]; END_IF;
                        END_FOR;
                        FOR cc := 0 TO 2 DO kg[cc] := kn[cc]; END_FOR;
                        Iter := it;
                        IF mx <= tlv * (1.0 + kmx) THEN
                            Conv := TRUE;
                            it := mi;
                        END_IF;
                    END_IF;
                END_FOR;
            END_IF;
            IF NOT Err THEN
                K1 := kg[0];
                K2 := kg[1];
                K3 := kg[2];
                P1 := g[0]; P2 := g[1]; P3 := g[2];
                P4 := g[3]; P5 := g[4]; P6 := g[5];
                P7 := g[6]; P8 := g[7]; P9 := g[8];
                Done := TRUE;
            END_IF;
        END_IF;
    END_IF;
    last := Execute;
END_FUNCTION_BLOCK

// FB_AtcLqrTune — servo-LQR gains from a discrete 2-state model via
// the 3x3 augmented DARE (FB_AtcDare3):
//   xa = [x1 x2 xi]', xi+ = xi + (r - y)*Ts  (y = x1)
//   Aa = [[A 0],[-Ts 0 1]], Ba = [[B],[0]], Q = diag(Q1,Q2,Qi)
// Output Ki is already negated to the FB_AtcLqr/FB_AtcLqg convention
// (u = Nref*SP - K1*x1 - K2*x2 + Ki*xi, Ki > 0 for heating).
// The solve runs in one scan on a rising Execute edge; Done stays
// set until the next edge. Conv = gain converged within Tol.
FUNCTION_BLOCK FB_AtcLqrTune
VAR_INPUT
    Execute : BOOL;
    A11 : LREAL;
    A12 : LREAL;
    A21 : LREAL;
    A22 : LREAL;
    B1 : LREAL;
    B2 : LREAL;
    Q1 : LREAL;            // weight on tracking state x1
    Q2 : LREAL;            // weight on x2
    Qi : LREAL;            // weight on integral state (raises Ki)
    R : LREAL;             // weight on u (>0)
    Ts : LREAL;            // discretization step (s)
    MaxIter : DINT;        // 0 -> 30
    Tol : LREAL;           // 0 -> 1e-10
END_VAR
VAR_OUTPUT
    Done : BOOL;
    Err : BOOL;
    Conv : BOOL;
    K1 : LREAL;
    K2 : LREAL;
    Ki : LREAL;
    Iter : DINT;
END_VAR
VAR
    last : BOOL;
    sv : FB_AtcDare3;
END_VAR
    IF Execute AND NOT last THEN
        Done := FALSE;
        Err := FALSE;
        Conv := FALSE;
        IF R <= 0.0 OR Ts <= 0.0 THEN
            Err := TRUE;
        ELSE
            sv(Execute := TRUE,
               A1 := A11, A2 := A12, A3 := 0.0,
               A4 := A21, A5 := A22, A6 := 0.0,
               A7 := -Ts, A8 := 0.0, A9 := 1.0,
               B1 := B1, B2 := B2, B3 := 0.0,
               Q11 := Q1, Q12 := 0.0, Q13 := 0.0,
               Q22 := Q2, Q23 := 0.0, Q33 := Qi,
               R := R, MaxIter := MaxIter, LyapIter := 0,
               Tol := Tol);
            K1 := sv.K1;
            K2 := sv.K2;
            Ki := -sv.K3;
            Iter := sv.Iter;
            Conv := sv.Conv;
            Err := sv.Err;
            Done := sv.Done;
        END_IF;
    END_IF;
    last := Execute;
END_FUNCTION_BLOCK

// FB_AtcKalmanTune — steady-state 2-state Kalman gains via the
// predictor-form algebraic Riccati equation (C = [1 0]):
//   P = A P A' - A P C'(R + C P C')^-1 C P A' + Q
// which is the DARE on the dual pair (A', C'), solved by
// FB_AtcDare3 with the system padded to 3x3. The output is the
// filter-form gain L = P C' (C P C' + R)^-1 as applied by
// FB_AtcLqg:  xh = xp + L*(y - xp1).
FUNCTION_BLOCK FB_AtcKalmanTune
VAR_INPUT
    Execute : BOOL;
    A11 : LREAL;
    A12 : LREAL;
    A21 : LREAL;
    A22 : LREAL;
    Q1 : LREAL;            // process noise on x1
    Q2 : LREAL;            // process noise on x2
    R : LREAL;             // measurement noise (>0)
    MaxIter : DINT;        // 0 -> 30
    Tol : LREAL;           // 0 -> 1e-10
END_VAR
VAR_OUTPUT
    Done : BOOL;
    Err : BOOL;
    Conv : BOOL;
    L1 : LREAL;
    L2 : LREAL;
    Iter : DINT;
END_VAR
VAR
    last : BOOL;
    sv : FB_AtcDare3;
    s : LREAL;
END_VAR
    IF Execute AND NOT last THEN
        Done := FALSE;
        Err := FALSE;
        Conv := FALSE;
        IF R <= 0.0 THEN
            Err := TRUE;
        ELSE
            sv(Execute := TRUE,
               A1 := A11, A2 := A21, A3 := 0.0,
               A4 := A12, A5 := A22, A6 := 0.0,
               A7 := 0.0, A8 := 0.0, A9 := 0.0,
               B1 := 1.0, B2 := 0.0, B3 := 0.0,
               Q11 := Q1, Q12 := 0.0, Q13 := 0.0,
               Q22 := Q2, Q23 := 0.0, Q33 := 0.0,
               R := R, MaxIter := MaxIter, LyapIter := 0,
               Tol := Tol);
            Iter := sv.Iter;
            Conv := sv.Conv;
            Err := sv.Err;
            // filter gain L = P C' / (C P C' + R)
            s := sv.P1 + R;
            IF s <= 0.0 THEN
                Err := TRUE;
            ELSE
                L1 := sv.P1 / s;
                L2 := sv.P4 / s;
            END_IF;
            Done := sv.Done;
        END_IF;
    END_IF;
    last := Execute;
END_FUNCTION_BLOCK

// ============================ autotune ============================

// FB_AtcRelayTune — Astrom-Hagglund relay-feedback autotuner.
// Drives Out = MeanOut +/- RelayAmp with hysteresis Hyst around SP
// until sustained oscillation is measured, then applies a tuning
// rule to Ku = 4*RelayAmp/(pi*A), Tu = oscillation period:
//   TuneRule 0: ZN classic      Kp=.6Ku  Tn=.5Tu  Tv=.125Tu
//             1: ZN some-ovsh   Kp=.33Ku Tn=.5Tu  Tv=.333Tu
//             2: ZN no-ovsh     Kp=.2Ku  Tn=.5Tu  Tv=.333Tu
//             3: Tyreus-Luyben  Kp=.45Ku Tn=2.2Tu Tv=.159Tu
// The run needs MinCyc (default 3, max 6) consistent periods; Tu and
// A are averaged over the last two periods. Set Abort to bail early —
// Out then returns to MeanOut. On Done the loop can switch to
// FB_AtcPid with Kp/Tn/Tv (feed Out through FB_AtcRateLim for a
// bumpless handover if the relay mean differs from steady-state).
FUNCTION_BLOCK FB_AtcRelayTune
VAR_INPUT
    Execute : BOOL;
    Setpoint : LREAL;
    Actual : LREAL;
    RelayAmp : LREAL;      // relay half-amplitude (out units) > 0
    MeanOut : LREAL;       // relay centre (e.g. 30 for gentle heat)
    Hyst : LREAL;          // hysteresis (deg) > sensor noise
    OutMin : LREAL;
    OutMax : LREAL;
    TuneRule : DINT;       // 0..3 (see header)
    MinCyc : DINT;         // periods to collect (0 -> 3, max 6)
    CycleTime : LREAL;
    Abort : BOOL;
    Reset : BOOL;
END_VAR
VAR_OUTPUT
    Done : BOOL;
    Busy : BOOL;
    Out : LREAL;
    Ku : LREAL;
    Tu : LREAL;            // s
    Amp : LREAL;           // measured oscillation amplitude
    Kp : LREAL;
    Tn : LREAL;
    Tv : LREAL;
    Cycles : DINT;
    Err : BOOL;
END_VAR
VAR
    hi : BOOL;
    prevHi : BOOL;
    tUp : LREAL;           // time of last upward crossing
    per1 : LREAL;          // last two periods
    per2 : LREAL;
    loPk : LREAL;
    hiPk : LREAL;
    a1 : LREAL;            // last two amplitudes
    a2 : LREAL;
    prevUp : BOOL;         // prev scan: PV >= SP
    t : LREAL;
    kuv : LREAL;
    u : LREAL;
    nc : DINT;
    rule : DINT;
END_VAR
    IF Reset THEN
        hi := FALSE;
        prevHi := FALSE;
        tUp := 0.0;
        per1 := 0.0;
        per2 := 0.0;
        loPk := 0.0;
        hiPk := 0.0;
        a1 := 0.0;
        a2 := 0.0;
        prevUp := FALSE;
        t := 0.0;
        Cycles := 0;
        Busy := FALSE;
        Done := FALSE;
        Err := FALSE;
        Out := MeanOut;
    END_IF;
    IF Execute AND NOT Done THEN
        Err := FALSE;
        IF CycleTime <= 0.0 OR RelayAmp <= 0.0 OR Hyst < 0.0 THEN
            Err := TRUE;
        ELSIF Abort THEN
            Busy := FALSE;
            Out := MeanOut;
        ELSE
            Busy := TRUE;
            t := t + CycleTime;
            // relay with hysteresis about SP
            IF hi AND Actual > Setpoint + Hyst THEN
                hi := FALSE;
            END_IF;
            IF NOT hi AND Actual < Setpoint - Hyst THEN
                hi := TRUE;
            END_IF;
            // extrema tracking between switchings
            IF hi <> prevHi THEN
                IF NOT hi THEN
                    // just switched low->... record high peak
                    IF hiPk > 0.0 THEN a2 := a1; a1 := (hiPk - loPk) * 0.5; END_IF;
                    loPk := Actual;
                    hiPk := Actual;
                ELSE
                    IF hiPk > 0.0 THEN a2 := a1; a1 := (hiPk - loPk) * 0.5; END_IF;
                    loPk := Actual;
                    hiPk := Actual;
                END_IF;
            ELSE
                IF Actual > hiPk THEN hiPk := Actual; END_IF;
                IF Actual < loPk THEN loPk := Actual; END_IF;
            END_IF;
            prevHi := hi;
            // upward crossing of SP counts a period
            IF NOT prevUp AND Actual >= Setpoint THEN
                IF tUp > 0.0 THEN
                    per2 := per1;
                    per1 := t - tUp;
                    nc := MinCyc;
                    IF nc <= 0 THEN nc := 3; END_IF;
                    IF nc > 6 THEN nc := 6; END_IF;
                    Cycles := Cycles + 1;
                    IF Cycles >= nc AND per2 > 0.0 AND a2 > 0.0 THEN
                        Tu := 0.5 * (per1 + per2);
                        Amp := 0.5 * (a1 + a2);
                        kuv := 4.0 * RelayAmp /
                              (3.14159265358979 * Amp);
                        Ku := kuv;
                        rule := TuneRule;
                        CASE rule OF
                            1: // ZN some overshoot
                                Kp := 0.33 * kuv;
                                Tn := 0.5 * Tu;
                                Tv := Tu / 3.0;
                            2: // ZN no overshoot
                                Kp := 0.2 * kuv;
                                Tn := 0.5 * Tu;
                                Tv := Tu / 3.0;
                            3: // Tyreus-Luyben
                                Kp := 0.45 * kuv;
                                Tn := 2.2 * Tu;
                                Tv := Tu / 6.3;
                        ELSE // 0: ZN classic
                                Kp := 0.6 * kuv;
                                Tn := 0.5 * Tu;
                                Tv := 0.125 * Tu;
                        END_CASE;
                        Out := MeanOut;
                        Busy := FALSE;
                        Done := TRUE;
                    END_IF;
                END_IF;
                tUp := t;
            END_IF;
            prevUp := Actual >= Setpoint;
            IF Busy THEN
                u := MeanOut;
                IF hi THEN u := u + RelayAmp; ELSE u := u - RelayAmp; END_IF;
                IF u > OutMax THEN u := OutMax; END_IF;
                IF u < OutMin THEN u := OutMin; END_IF;
                Out := u;
            END_IF;
        END_IF;
    END_IF;
END_FUNCTION_BLOCK

// FB_AtcStepIdent — open-loop step-response identification of a FOPDT
// model G(s) = K e^{-Theta s}/(1 + Tau s):
//   phase 1: Out=U0 for SettleT, baseline PV0 recorded
//   phase 2: Out=U1; PV is sampled every StoreEvery scans into a
//            512-deep trace until PV holds within TolBand for
//            SettleN samples or MaxTime is reached
//   then:    Delta = PVf - PV0; K = Delta/(U1-U0);
//            t35/t85 interpolated from the trace;
//            Tau = 0.6749*(t85 - t35); Theta = t35 - 0.4354*Tau
// Trace window = 512*StoreEvery*CycleTime — pick StoreEvery so the
// step settles inside it (e.g. Ts=0.5s, StoreEvery=20 -> 5120 s).
FUNCTION_BLOCK FB_AtcStepIdent
VAR_INPUT
    Execute : BOOL;
    Actual : LREAL;
    U0 : LREAL;            // baseline output
    U1 : LREAL;            // step output
    SettleT : LREAL;       // baseline hold time (s) before stepping
    TolBand : LREAL;       // settle band (deg)
    SettleN : DINT;        // samples inside TolBand declaring settle (0->10)
    MaxTime : LREAL;       // give-up time (s); 0 -> window length
    StoreEvery : DINT;     // decimation (0 -> 1)
    CycleTime : LREAL;
    Reset : BOOL;
END_VAR
VAR_OUTPUT
    Done : BOOL;
    Busy : BOOL;
    Out : LREAL;
    K : LREAL;
    Tau : LREAL;
    Theta : LREAL;
    Pv0 : LREAL;
    PvFinal : LREAL;
    T35 : LREAL;
    T85 : LREAL;
    Err : BOOL;
    ErrId : INT;           // 1 params  2 trace overflow  3 tiny step
END_VAR
VAR
    tr : ARRAY[0..511] OF LREAL;
    phase : DINT;          // 1 baseline, 2 step, 3 finished
    t : LREAL;
    scnt : DINT;
    ns : DINT;             // stored samples
    sn : DINT;             // stored settle count
    i : DINT;
    dlt : LREAL;
    f35 : LREAL;
    f85 : LREAL;
    y : LREAL;
    yp : LREAL;
    tsmp : LREAL;
    se : DINT;
    nset : DINT;
END_VAR
    IF Reset THEN
        phase := 0;
        t := 0.0;
        scnt := 0;
        ns := 0;
        sn := 0;
        Busy := FALSE;
        Done := FALSE;
        Err := FALSE;
        Out := U0;
    END_IF;
    IF phase < 3 THEN
        Done := FALSE;
        Err := FALSE;
    END_IF;
    IF Execute AND phase < 3 THEN
        IF CycleTime <= 0.0 OR U1 = U0 THEN
            Err := TRUE;
            ErrId := 1;
            phase := 3;
        ELSE
            Busy := TRUE;
            se := StoreEvery;
            IF se <= 0 THEN se := 1; END_IF;
            nset := SettleN;
            IF nset <= 0 THEN nset := 10; END_IF;
            IF phase = 0 THEN
                phase := 1;
                t := 0.0;
            END_IF;
            IF phase = 1 THEN
                Out := U0;
                t := t + CycleTime;
                IF t >= SettleT THEN
                    Pv0 := Actual;
                    phase := 2;
                    t := 0.0;
                    scnt := se;        // store immediately
                    ns := 0;
                    sn := 0;
                    Out := U1;
                END_IF;
            ELSIF phase = 2 THEN
                Out := U1;
                t := t + CycleTime;
                scnt := scnt + 1;
                IF scnt >= se THEN
                    scnt := 0;
                    IF ns < 512 THEN
                        tr[ns] := Actual;
                        ns := ns + 1;
                        // settle: |pv - latest| < TolBand persisting
                        IF ns > 1 THEN
                            IF Actual - tr[ns - 2] > TolBand OR
                               tr[ns - 2] - Actual > TolBand THEN
                                sn := 0;
                            ELSE
                                sn := sn + 1;
                            END_IF;
                        END_IF;
                    ELSE
                        Err := TRUE;
                        ErrId := 2;
                    END_IF;
                END_IF;
                IF t >= MaxTime AND MaxTime > 0.0 THEN sn := nset; END_IF;
                IF ns >= 512 THEN sn := nset; END_IF;
                IF sn >= nset AND ns >= 4 THEN
                    // post-process the stored trace
                    PvFinal := tr[ns - 1];
                    dlt := PvFinal - Pv0;
                    IF dlt = 0.0 THEN
                        Err := TRUE;
                        ErrId := 3;
                    ELSE
                        tsmp := CycleTime * DINT_TO_LREAL(se);
                        f35 := -1.0;
                        f85 := -1.0;
                        yp := 0.0;
                        FOR i := 1 TO ns - 1 DO
                            y := (tr[i] - Pv0) / dlt;
                            yp := (tr[i - 1] - Pv0) / dlt;
                            IF f35 < 0.0 AND y >= 0.353 AND y > yp THEN
                                f35 := DINT_TO_LREAL(i - 1) +
                                       (0.353 - yp) / (y - yp);
                            END_IF;
                            IF f85 < 0.0 AND y >= 0.853 AND y > yp THEN
                                f85 := DINT_TO_LREAL(i - 1) +
                                       (0.853 - yp) / (y - yp);
                            END_IF;
                        END_FOR;
                        T35 := f35 * tsmp;
                        T85 := f85 * tsmp;
                        K := dlt / (U1 - U0);
                        IF f35 < 0.0 OR f85 < 0.0 THEN
                            // response never reached the marks:
                            // fall back to Tau = time to 63%, Theta = 0
                            f85 := -1.0;
                            FOR i := 1 TO ns - 1 DO
                                y := (tr[i] - Pv0) / dlt;
                                yp := (tr[i - 1] - Pv0) / dlt;
                                IF f85 < 0.0 AND y >= 0.632 AND y > yp THEN
                                    f85 := DINT_TO_LREAL(i - 1) +
                                           (0.632 - yp) / (y - yp);
                                END_IF;
                            END_FOR;
                            IF f85 >= 0.0 THEN
                                Tau := f85 * tsmp;
                            ELSE
                                Tau := DINT_TO_LREAL(ns) * tsmp;
                            END_IF;
                            Theta := 0.0;
                        ELSE
                            Tau := 0.6749 * (T85 - T35);
                            Theta := T35 - 0.4354 * Tau;
                            IF Theta < 0.0 THEN Theta := 0.0; END_IF;
                        END_IF;
                    END_IF;
                    phase := 3;
                    Busy := FALSE;
                    Done := NOT Err;
                END_IF;
            END_IF;
        END_IF;
    END_IF;
END_FUNCTION_BLOCK

// FB_AtcTuneRules — PID parameters from a FOPDT model (K, Tau, Theta
// as produced by FB_AtcStepIdent). Rule on rising Execute edge:
//   0 IMC/Rivera   lambda = max(0.25*Theta, 0.2*Tau) or Lambda input
//   1 SIMC         lambda = Theta (Skogestad; Tn = min(Tau,4*(l+th)))
//   2 ZN open-loop Kp=1.2*tau/(K*th) Tn=2th Tv=0.5th
//   3 Cohen-Coon   classic CC reaction-curve formulas
//   4 AMIGO        approx-AMIGO PI/PID (Astrom-Hagglund)
// Lambda input overrides the default for rules 0/1 when > 0.
FUNCTION_BLOCK FB_AtcTuneRules
VAR_INPUT
    Execute : BOOL;
    K : LREAL;
    Tau : LREAL;
    Theta : LREAL;
    Rule : DINT;
    Lambda : LREAL;        // >0 overrides the rule's default lambda
END_VAR
VAR_OUTPUT
    Done : BOOL;
    Err : BOOL;
    Kp : LREAL;
    Tn : LREAL;
    Tv : LREAL;
END_VAR
VAR
    last : BOOL;
    l : LREAL;
    r : LREAL;
END_VAR
    IF Execute AND NOT last THEN
        Done := FALSE;
        Err := FALSE;
        IF K = 0.0 OR Tau <= 0.0 OR Theta < 0.0 THEN
            Err := TRUE;
        ELSE
            l := Lambda;
            CASE Rule OF
                1: // SIMC
                    IF l <= 0.0 THEN l := Theta; END_IF;
                    IF l < 0.01 * Tau THEN l := 0.01 * Tau; END_IF;
                    Kp := Tau / (K * (l + Theta));
                    r := 4.0 * (l + Theta);
                    Tn := Tau;
                    IF r < Tn THEN Tn := r; END_IF;
                    Tv := 0.0;
                2: // Ziegler-Nichols reaction curve
                    Kp := 1.2 * Tau / (K * Theta);
                    Tn := 2.0 * Theta;
                    Tv := 0.5 * Theta;
                3: // Cohen-Coon
                    r := Theta / Tau;
                    Kp := (Tau / (K * Theta)) *
                          (1.3333 + 0.3333 * r);
                    Tn := Theta * (3.3333 + 3.3333 * r) /
                          (1.0 + 2.2 * r);
                    Tv := Theta * 0.3704 /
                          (1.0 + 0.2 * r);
                4: // AMIGO
                    r := Theta / Tau;
                    Kp := (0.2 + 0.45 / r) / K;
                    Tn := Theta * (0.4 + 0.8 / r) / (0.1 + 1.0 / r) *
                          (r + 0.1) / r;
                    Tv := 0.5 * Theta /
                          (0.3 + 1.0 / r);
            ELSE // 0: IMC/Rivera
                    IF l <= 0.0 THEN
                        l := 0.25 * Theta;
                        IF 0.2 * Tau > l THEN l := 0.2 * Tau; END_IF;
                    END_IF;
                    Kp := (Tau + 0.5 * Theta) /
                          (K * (l + 0.5 * Theta));
                    Tn := Tau + 0.5 * Theta;
                    Tv := Tau * Theta / (2.0 * Tau + Theta);
            END_CASE;
            Done := TRUE;
        END_IF;
    END_IF;
    last := Execute;
END_FUNCTION_BLOCK

// ============================ profile ============================

// ST_AtcSeg — one profile segment for FB_AtcProfile.
//   KIND  0 END      finish (Done)
//         1 DWELL    hold TGT for P1 seconds; if P2>0 the timer only
//                    advances while |PV - TGT| <= P2 (guaranteed soak)
//         2 RAMP     ramp SP to TGT at |P1| deg/s (P1<=0 acts as STEP)
//         3 RAMPT    ramp SP to TGT in exactly P1 seconds
//         4 STEP     SP := TGT immediately, advance next scan
//         5 LOOP     jump to segment TRUNC(TGT), P1 times total
//   TGT   target deg (LOOP: target segment index as LREAL)
//   P1    dwell s / ramp deg-per-s / ramp s / loop count
//   P2    guaranteed-soak band (deg); 0 = off (DWELL only)
//   EV    event word exposed on EV while the segment is active
TYPE ST_AtcSeg : STRUCT
    KIND : DINT;
    TGT : LREAL;
    P1 : LREAL;
    P2 : LREAL;
    EV : DWORD;
END_STRUCT
END_TYPE

// FB_AtcProfile — setpoint profile programmer for temperature
// recipes. Segments live in the SEG array input (write member-wise:
// prof.SEG[1].KIND := 2; ...). NUM_SEG entries are considered.
//   RUN rising edge starts (SegIdx=1; SP := PV when PvStart else SP
//   keeps its value). HOLD pauses ramp progress and dwell timers.
//   RESET aborts: Busy off, SP := PV (safe restart — no thermal jump).
// Outputs expose current SP, segment index/time, instantaneous ramp
// rate, remaining-time estimate (-1 when unbounded), the active
// segment's EV word, and Done/Busy.
FUNCTION_BLOCK FB_AtcProfile
VAR_INPUT
    SEG : ARRAY[1..32] OF ST_AtcSeg;
    NUM_SEG : DINT;        // segments considered (1..32)
    RUN : BOOL;
    HOLD : BOOL;
    RESET : BOOL;
    PvStart : BOOL;        // start ramps from measured PV
    PV : LREAL;            // process value (PV-start, guaranteed soak)
    CycleTime : LREAL;
END_VAR
VAR_OUTPUT
    SP : LREAL;
    Done : BOOL;
    Busy : BOOL;
    SegIdx : DINT;
    SegTime : LREAL;       // s inside the active segment
    SegTgt : LREAL;        // target of the active segment
    RateNow : LREAL;       // active ramp rate (deg/s)
    RemTime : LREAL;       // est. s remaining in segment (-1 n/a)
    EV : DWORD;
    Err : BOOL;
END_VAR
VAR
    lc : ARRAY[1..32] OF DINT;   // remaining LOOP counts
    runLast : BOOL;
    segStart : LREAL;            // SP at segment entry
    adv : BOOL;
    i : DINT;
    n : DINT;
    k : DINT;
    r : LREAL;
    dd : LREAL;
END_VAR
    IF RESET THEN
        Busy := FALSE;
        Done := FALSE;
        SegIdx := 0;
        SegTime := 0.0;
        RateNow := 0.0;
        RemTime := -1.0;
        EV := 0;
        SP := PV;
        runLast := FALSE;
        Err := FALSE;
        RETURN;
    END_IF;
    IF RUN AND NOT runLast THEN
        IF NUM_SEG < 1 THEN
            // no segment table yet (e.g. config loads later in the
            // scan): hold the request and retry — do NOT start a
            // zero-segment profile, which would end immediately
            Err := TRUE;
        ELSE
            n := NUM_SEG;
            IF n > 32 THEN n := 32; END_IF;
            FOR i := 1 TO 32 DO
                lc[i] := TRUNC(SEG[i].P1);
            END_FOR;
            SegIdx := 1;
            SegTime := 0.0;
            IF PvStart THEN SP := PV; END_IF;
            segStart := SP;
            Busy := TRUE;
            Done := FALSE;
            Err := FALSE;
            RateNow := 0.0;
            RemTime := -1.0;
            runLast := TRUE;
        END_IF;
    END_IF;
    IF NOT RUN THEN
        runLast := FALSE;
    END_IF;
    IF Busy THEN
        IF CycleTime <= 0.0 THEN
            Err := TRUE;
            Busy := FALSE;
        ELSE
            n := NUM_SEG;
            IF n < 1 THEN n := 1; END_IF;
            IF n > 32 THEN n := 32; END_IF;
            IF SegIdx < 1 THEN SegIdx := 1; END_IF;
            IF SegIdx > n THEN
                // ran off the end without an END segment
                Busy := FALSE;
                Done := TRUE;
                EV := 0;
            ELSE
                EV := SEG[SegIdx].EV;
                adv := FALSE;
                IF NOT HOLD THEN
                    SegTime := SegTime + CycleTime;
                END_IF;
                k := TRUNC(SEG[SegIdx].KIND);
                CASE k OF
                    1: // DWELL — timer runs unless HOLD/g-soak band
                        SegTgt := SEG[SegIdx].TGT;
                        SP := SegTgt;
                        RateNow := 0.0;
                        RemTime := -1.0;
                        IF HOLD THEN
                            // frozen
                        ELSIF SEG[SegIdx].P2 > 0.0 THEN
                            // guaranteed soak: rewind the tick while
                            // PV is outside the band
                            IF PV - SegTgt > SEG[SegIdx].P2 OR
                               SegTgt - PV > SEG[SegIdx].P2 THEN
                                SegTime := SegTime - CycleTime;
                            END_IF;
                            RemTime := SEG[SegIdx].P1 - SegTime;
                        ELSE
                            RemTime := SEG[SegIdx].P1 - SegTime;
                        END_IF;
                        IF NOT HOLD AND SegTime >= SEG[SegIdx].P1 THEN
                            adv := TRUE;
                        END_IF;
                    2: // RAMP — slew at |P1| deg/s toward TGT
                        SegTgt := SEG[SegIdx].TGT;
                        r := SEG[SegIdx].P1;
                        IF r < 0.0 THEN r := -r; END_IF;
                        IF r <= 0.0 OR HOLD THEN
                            RateNow := 0.0;
                            IF r <= 0.0 THEN
                                SP := SegTgt;
                                adv := TRUE;
                            END_IF;
                        ELSE
                            dd := SegTgt - SP;
                            RateNow := r;
                            IF dd < 0.0 THEN RateNow := -r; END_IF;
                            SP := SP + RateNow * CycleTime;
                            // landing check (no overshoot)
                            IF (RateNow > 0.0 AND SP >= SegTgt) OR
                               (RateNow < 0.0 AND SP <= SegTgt) THEN
                                SP := SegTgt;
                                adv := TRUE;
                            END_IF;
                            IF RateNow <> 0.0 THEN
                                RemTime := (SegTgt - SP) / RateNow;
                            ELSE
                                RemTime := 0.0;
                            END_IF;
                        END_IF;
                    3: // RAMPT — reach TGT in P1 s from segStart
                        SegTgt := SEG[SegIdx].TGT;
                        IF SEG[SegIdx].P1 <= 0.0 THEN
                            SP := SegTgt;
                            RateNow := 0.0;
                            adv := TRUE;
                        ELSE
                            r := (SegTgt - segStart) / SEG[SegIdx].P1;
                            RateNow := r;
                            IF NOT HOLD THEN
                                SP := SP + r * CycleTime;
                                IF (r > 0.0 AND SP >= SegTgt) OR
                                   (r < 0.0 AND SP <= SegTgt) OR
                                   SegTime >= SEG[SegIdx].P1 THEN
                                    SP := SegTgt;
                                    adv := TRUE;
                                END_IF;
                            END_IF;
                            RemTime := SEG[SegIdx].P1 - SegTime;
                        END_IF;
                    4: // STEP — jump, advance next scan
                        SP := SEG[SegIdx].TGT;
                        SegTgt := SEG[SegIdx].TGT;
                        RateNow := 0.0;
                        RemTime := 0.0;
                        adv := TRUE;
                    5: // LOOP — jump back P1 times
                        SegTgt := 0.0;
                        RateNow := 0.0;
                        RemTime := -1.0;
                        IF lc[SegIdx] > 0 THEN
                            lc[SegIdx] := lc[SegIdx] - 1;
                            k := TRUNC(SEG[SegIdx].TGT);
                            IF k >= 1 AND k <= n THEN
                                SegIdx := k;
                                SegTime := 0.0;
                                segStart := SP;
                            ELSE
                                adv := TRUE;   // bad target: drop
                            END_IF;
                        ELSE
                            adv := TRUE;
                        END_IF;
                ELSE // 0 END (and unknown kinds terminate)
                        RateNow := 0.0;
                        RemTime := -1.0;
                        Busy := FALSE;
                        Done := TRUE;
                        EV := 0;
                END_CASE;
                IF adv AND Busy THEN
                    SegIdx := SegIdx + 1;
                    SegTime := 0.0;
                    segStart := SP;
                    RateNow := 0.0;
                    EV := 0;
                END_IF;
            END_IF;
        END_IF;
    END_IF;
END_FUNCTION_BLOCK
