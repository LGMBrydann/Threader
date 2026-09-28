// ============================================================
// CONFIG
// ============================================================

const API_BASE = "/api";


// ============================================================
// YEAR
// ============================================================

const yearElement = document.getElementById("year");

if (yearElement) {
    yearElement.textContent = new Date().getFullYear();
}


// ============================================================
// API STATUS
// ============================================================

async function checkAPI() {

    const statusText =
        document.getElementById("status-text");

    const statusDot =
        document.querySelector(".status-dot");

    if (!statusText) {
        return;
    }

    try {

        const response = await fetch(
            `${API_BASE}/status`,
            {
                method: "GET",
                headers: {
                    "Accept": "application/json"
                }
            }
        );

        if (!response.ok) {
            throw new Error("API unavailable");
        }

        const data = await response.json();

        if (data.online === true) {

            statusText.textContent =
                "Threader API is online";

            if (statusDot) {
                statusDot.style.background =
                    "#6ee7a0";

                statusDot.style.color =
                    "#6ee7a0";
            }

        } else {

            statusText.textContent =
                "API is responding";

        }

    } catch (error) {

        console.warn(
            "Threader API status check failed:",
            error
        );

        statusText.textContent =
            "API status unavailable";

        if (statusDot) {
            statusDot.style.background =
                "#f59e0b";

            statusDot.style.color =
                "#f59e0b";
        }
    }
}


checkAPI();


// ============================================================
// MOCK DISCORD 3D TILT
// ============================================================

const discordWrapper =
    document.querySelector(".discord-wrapper");

const discordWindow =
    document.querySelector(".discord-window");


if (
    discordWrapper &&
    discordWindow &&
    window.matchMedia("(pointer: fine)").matches
) {

    discordWrapper.addEventListener(
        "mousemove",
        (event) => {

            const rect =
                discordWrapper.getBoundingClientRect();

            const x =
                (event.clientX - rect.left)
                / rect.width;

            const y =
                (event.clientY - rect.top)
                / rect.height;

            const rotateY =
                (x - 0.5) * 8;

            const rotateX =
                (0.5 - y) * 7;

            discordWindow.style.transform =
                `
                rotateY(${rotateY}deg)
                rotateX(${rotateX}deg)
                `;
        }
    );


    discordWrapper.addEventListener(
        "mouseleave",
        () => {

            discordWindow.style.transform =
                "rotateY(-5deg) rotateX(3deg)";
        }
    );
}


// ============================================================
// SMOOTH ANCHOR LINKS
// ============================================================

document
    .querySelectorAll('a[href^="#"]')
    .forEach((link) => {

        link.addEventListener(
            "click",
            (event) => {

                const targetId =
                    link.getAttribute("href");

                if (
                    !targetId ||
                    targetId === "#"
                ) {
                    return;
                }

                const target =
                    document.querySelector(targetId);

                if (!target) {
                    return;
                }

                event.preventDefault();

                target.scrollIntoView({
                    behavior: "smooth",
                    block: "start"
                });
            }
        );
    });


// ============================================================
// SCROLL REVEALS
// ============================================================

const revealElements =
    document.querySelectorAll(
        ".feature-card, " +
        ".setup-card, " +
        ".example-row, " +
        ".command-row, " +
        ".cta-section"
    );


if (
    "IntersectionObserver" in window
) {

    const observer =
        new IntersectionObserver(
            (entries) => {

                entries.forEach((entry) => {

                    if (!entry.isIntersecting) {
                        return;
                    }

                    entry.target.classList.add(
                        "visible"
                    );

                    observer.unobserve(
                        entry.target
                    );
                });

            },
            {
                threshold: 0.12
            }
        );


    revealElements.forEach(
        (element) => {
            observer.observe(element);
        }
    );

}


// ============================================================
// BUTTON MICRO-INTERACTION
// ============================================================

document
    .querySelectorAll(".primary-button")
    .forEach((button) => {

        button.addEventListener(
            "pointerdown",
            () => {

                button.style.transform =
                    "translateY(1px) scale(0.98)";
            }
        );


        button.addEventListener(
            "pointerup",
            () => {

                button.style.transform = "";
            }
        );


        button.addEventListener(
            "pointerleave",
            () => {

                button.style.transform = "";
            }
        );

    });


// ============================================================
// PERIODIC API CHECK
// ============================================================

setInterval(
    checkAPI,
    30000
);
