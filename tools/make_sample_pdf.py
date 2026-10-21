"""Create the fictional Harbour City congestion-charge consultation PDF.

The document is written for The Social World (CC BY 4.0) and is deliberately
concrete so agents can cite pages and numbers. It is not a real policy paper.
"""
from __future__ import annotations

from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "examples" / "harbour-city-congestion-charge.pdf"


PAGES = [
    ("Harbour City Council", "Congestion Charge Consultation Proposal", [
        ("A fictional policy document written for The Social World's sample world.", True),
        ("Prepared by the Harbour City Transport Committee · October 2026", False),
        ("Status: consultation draft · 12-week public consultation", False),
        ("This document is not a real government proposal. All places, numbers and names are "
         "invented so that a simulated population can debate a concrete policy.", False),
    ]),
    ("1. Executive summary", "", [
        ("Harbour City proposes a weekday congestion charge of £6 for private vehicles entering "
         "the central zone between 07:00 and 19:00, Monday to Friday.", False),
        ("The council expects the charge to cut central traffic by 18% within 18 months, raise "
         "£180 million gross each year and reduce nitrogen dioxide at the nine worst monitoring "
         "stations. After £32 million of operating costs, £148 million would be reinvested in "
         "public transport, walking and road safety.", False),
        ("Residents inside the zone would receive a 90% discount. Blue Badge holders, emergency "
         "vehicles and motorcycles would be exempt. Delivery vans would be exempt until 2028. "
         "Low-income households would receive a 40% discount.", False),
        ("The committee recommends a 24-month pilot with a formal review after 12 months.", False),
    ]),
    ("2. The problem", "", [
        ("Central Harbour City carries 62,000 vehicle entries on an average weekday. Average "
         "traffic speed in the zone has fallen from 18.4 km/h in 2015 to 14.2 km/h in 2026.", False),
        ("Drivers lose an estimated 38 minutes per weekday to congestion. Bus passengers lose "
         "41 minutes on the three busiest corridors.", False),
        ("Nitrogen dioxide exceeds World Health Organization guideline levels at 9 of the 12 "
         "monitoring stations in the zone. The council's health assessment attributes 210 "
         "premature deaths a year to traffic-related air pollution.", False),
        ("Road collisions injure 340 people a year in the central zone, including 62 pedestrians "
         "and 28 cyclists. Traffic is the largest single source of the city's transport emissions.", False),
    ]),
    ("3. How the charge would work", "", [
        ("The zone covers 7.8 square kilometres between the river, the ring road and the university "
         "quarter. 142 automatic number-plate cameras would enforce it at 46 entry points.", False),
        ("The charge is £6 per private vehicle per day, charged once for unlimited entries. "
         "Payment is due by midnight the next day. A £12 penalty applies after 14 days.", False),
        ("Exemptions: Blue Badge holders, emergency vehicles, motorcycles, buses and coaches, "
         "and vehicles with zero tailpipe emissions registered before 2024.", False),
        ("Residents inside the zone pay 60p a day (90% discount). Low-income households receive a "
         "further 40% discount. Delivery vans are exempt until 1 January 2028.", False),
        ("The council estimates that 78% of drivers would pay through an app or automatic account. "
         "Payment terminals would be available at 22 libraries and community centres.", False),
    ]),
    ("4. Where the money would go", "", [
        ("Gross revenue: £180 million a year. Operating costs: £32 million (enforcement, IT, "
         "customer service, appeals). Net revenue: £148 million.", False),
        ("Allocation: 45% (£66.6m) to bus frequency and fares; 25% (£37m) to cycling and walking; "
         "20% (£29.6m) to road safety and school streets; 10% (£14.8m) to administration and "
         "monitoring.", False),
        ("The bus programme would add 14 vehicles on four routes, cut the Harbour Loop headway from "
         "12 to 8 minutes and cap fares for under-25s at £1.20. The council projects a 12% "
         "improvement in average bus journey times.", False),
        ("A ring-fenced reserve of £8 million would cover revenue shortfalls in the first two years.", False),
    ]),
    ("5. What the evidence says", "", [
        ("The council reviewed 14 congestion-charge schemes. The median reduction in central "
         "traffic was 15%, with a range from 6% to 28%. London reported a 15% reduction after "
         "introduction; Stockholm reported 20%; Singapore's electronic scheme reported 10% in its "
         "first year.", False),
        ("Evidence on air quality is mixed but positive: NO2 fell by 8–12% in most schemes, while "
         "traffic displaced to boundary roads rose by 3–7%. The council's model projects a 9% "
         "reduction in NO2 inside the zone and a 4% increase on the outer ring.", False),
        ("Retail studies find no consistent effect on city-centre sales. Three of five studies "
         "found no measurable change; one found a 2% fall in the first year; one found a 4% rise "
         "after reinvestment in public space.", False),
        ("The evidence base is weaker for small cities under 500,000 people. Harbour City has "
         "410,000 residents, so results may differ from London or Stockholm.", False),
    ]),
    ("6. Business impact", "", [
        ("The zone contains 7,800 registered businesses. A council survey of 620 businesses found "
         "23% support, 41% opposition and 36% undecided.", False),
        ("Delivery companies estimate an extra £4.50 per vehicle per day in charges. The proposed "
         "van exemption until 2028 is intended to give logistics firms time to consolidate "
         "deliveries and switch to electric vehicles.", False),
        ("Retailers on the high street are divided. Supporters point to fewer delivery conflicts "
         "and faster bus access; opponents fear that customers from outside the zone will shop "
         "elsewhere.", False),
        ("The council would create a £6 million business transition fund for independent shops, "
         "covering electric cargo bikes, shared delivery hubs and shopfront improvements.", False),
    ]),
    ("7. Equity and accessibility", "", [
        ("18% of Harbour City households do not own a car. 9% of residents report a disability "
         "that affects travel. 31% of households earn below the city's living-wage threshold.", False),
        ("The 90% resident discount and 40% low-income discount are designed so that no household "
         "pays more than 60p a day to drive inside its own neighbourhood. Blue Badge holders are "
         "exempt entirely.", False),
        ("The consultation would include six public meetings, two online sessions, a paper "
         "response form and translated materials in the city's five most-spoken languages. "
         "Community groups would receive £1,500 each to host their own discussions.", False),
        ("The committee acknowledges that charges are regressive unless revenue is returned to "
         "transport services used by people who do not drive. The bus and walking allocations are "
         "intended to do that, but the council would monitor distributional effects annually.", False),
    ]),
    ("8. Environment", "", [
        ("The council projects a reduction of 42,000 tonnes of CO2 a year, equivalent to taking "
         "9,000 cars off the road. NO2 inside the zone would fall by an estimated 9%; PM2.5 by 6%.", False),
        ("Traffic noise at the busiest boundary streets is projected to fall by 3 decibels, which "
         "is roughly a halving of perceived loudness. Displacement to the ring road would raise "
         "noise there by 1 decibel.", False),
        ("Zero-emission vehicles registered before 2024 are exempt. The council would review the "
         "exemption in 2029 as the fleet electrifies, because the charge is intended to reduce "
         "traffic, not only emissions.", False),
        ("Green space is not directly affected, but the walking programme would add 6 kilometres "
         "of segregated paths and 14 new crossings near schools.", False),
    ]),
    ("9. Implementation and enforcement", "", [
        ("Timeline: detailed design (3 months), procurement (4 months), camera installation "
         "(6 months), public information campaign (3 months), go-live in month 18.", False),
        ("Costs: cameras and signs £31 million; IT and payment platform £24 million; customer "
         "service and appeals £8 million a year; monitoring and evaluation £2 million a year.", False),
        ("Enforcement would be based on number-plate recognition. The council would publish an "
         "annual report on accuracy, appeals and data protection. Images would be deleted after "
         "90 days unless needed for an appeal.", False),
        ("The council would run a 24-month pilot. A formal review at 12 months would examine "
         "traffic, air quality, bus journeys, business impact and equity. The scheme could be "
         "amended or stopped after the review.", False),
    ]),
    ("10. Consultation questions", "", [
        ("1. Do you support a £6 weekday charge for private vehicles entering the central zone?", False),
        ("2. Are the proposed exemptions and discounts fair? Which groups are missing?", False),
        ("3. How should the £148 million net revenue be divided between buses, cycling, walking "
         "and road safety?", False),
        ("4. What would make the scheme work better for businesses, residents and disabled people?", False),
        ("5. Should the council proceed with a 24-month pilot, delay, or reject the proposal?", False),
        ("The consultation closes on 15 January 2027. Responses can be submitted online, by post "
         "or at any of the six public meetings.", False),
    ]),
    ("11. Recommendation and risks", "", [
        ("The Transport Committee recommends approving a 24-month pilot, subject to the "
         "consultation and a final vote by the full council.", False),
        ("Legal challenge: 20% likelihood, medium impact. Mitigation: publish the legal opinion and "
         "consultation record before the vote.", False),
        ("Revenue shortfall: 15% likelihood, medium impact. Mitigation: the £8 million reserve and a "
         "mid-year review.", False),
        ("Traffic displacement: 8% likelihood, high impact on boundary wards. Mitigation: boundary "
         "bus priority, school streets and a ring-road monitoring programme.", False),
        ("Business opposition: high likelihood, medium impact. Mitigation: the transition fund, the "
         "2028 van exemption and quarterly business forums.", False),
        ("Public legitimacy: the scheme depends on a transparent consultation and visible "
         "reinvestment. The committee recommends publishing a dashboard of traffic, air quality "
         "and spending every quarter.", False),
    ]),
    ("12. About this document", "", [
        ("This is a fictional document created for The Social World, an open-source AI social "
         "simulation lab. It is licensed CC BY 4.0. You may reuse and adapt it.", False),
        ("The numbers are internally consistent but invented. They are not forecasts and should "
         "not be cited as real evidence.", False),
        ("The sample world uses this document so that every simulated post can cite a page and a "
         "chunk. If you replace the source, the citations change with it.", False),
    ]),
]


def _ascii(text: str) -> str:
    """Keep the sample PDF self-contained and cleanly extractable with base14 fonts."""
    for a, b in (("£", "GBP "), ("–", "-"), ("—", "-"), ("’", "'"), ("‘", "'"),
                 ("“", '"'), ("”", '"'), ("…", "..."), ("·", "-"), ("→", "->")):
        text = text.replace(a, b)
    return text


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    doc = pymupdf.open()
    for i, (title, subtitle, paras) in enumerate(PAGES, start=1):
        page = doc.new_page(width=595, height=842)  # A4 portrait
        y = 64
        page.insert_text((56, y), _ascii("HARBOUR CITY COUNCIL"), fontsize=9, fontname="hebo",
                         color=(0.38, 0.40, 0.44))
        y += 34
        page.insert_textbox(pymupdf.Rect(56, y, 540, y + 70), _ascii(title), fontsize=22,
                            fontname="hebo", color=(0.07, 0.08, 0.10), lineheight=1.15)
        y += 54 if len(title) < 42 else 78
        if subtitle:
            page.insert_textbox(pymupdf.Rect(56, y, 540, y + 44), _ascii(subtitle), fontsize=13,
                                fontname="helv", color=(0.20, 0.22, 0.26), lineheight=1.3)
            y += 42
        y += 12
        for text, italic in paras:
            height = 120
            rc = page.insert_textbox(pymupdf.Rect(56, y, 540, y + height), _ascii(text),
                                     fontsize=10.5 if not italic else 9.5,
                                     fontname="helv" if not italic else "heit",
                                     color=(0.12, 0.13, 0.16), lineheight=1.45,
                                     align=0)
            if rc < 0:
                raise RuntimeError(f"page {i}: text overflow ({rc})")
            # estimate consumed height from the number of wrapped lines
            words = len(text.split())
            lines = max(1, words // 12 + 1)
            y += 15.2 * lines + 14
        page.insert_text((56, 812), _ascii(f"Harbour City congestion charge - consultation draft - page {i} of {len(PAGES)}"),
                         fontsize=8, fontname="helv", color=(0.45, 0.47, 0.50))
    doc.set_metadata({
        "title": "Harbour City Congestion Charge Consultation Proposal",
        "author": "Harbour City Transport Committee (fictional)",
        "subject": "A fictional policy document for The Social World sample simulation",
        "keywords": "congestion charge, consultation, fictional, sample world",
    })
    doc.save(str(OUT), garbage=4, deflate=True)
    doc.close()
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
