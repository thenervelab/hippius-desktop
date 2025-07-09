import { AbstractIconWrapper, P, Icons } from "@/components/ui";

const WaitAMoment: React.FC = () => (
    <div className="w-full h-[80vh] p-6 flex items-center justify-center">
        <div className="flex flex-col items-center justify-center">
            <AbstractIconWrapper className="size-6 flex items-center justify-center">
                <Icons.Timer className="size-4 text-primary-50 relative" />
            </AbstractIconWrapper>
            <P className="text-center mt-2 text-grey-60 max-w-[190px]" size="sm">
                Wait a moment...
            </P>
        </div>
    </div>
);

export default WaitAMoment;
